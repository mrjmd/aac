/**
 * Nightly lead-leak queue (route: /api/lead-leaks, Vercel cron 09:15 UTC,
 * after the scorecard; 09:35 and 09:55 finish a run its budget cut short).
 * Reads every business-line thread with a customer message in the last 90
 * days, drops the quoted and booked ones, and has the model sort the rest
 * into dropped stages (`@aac/lead-leaks`). Unchanged threads reuse their
 * cached read. Saves
 * the snapshot for the command center's Sales page. Writes only
 * `lead-leaks:*`. Sends nothing.
 *
 * Once per Eastern day; `?force=1` (middleware secret) runs again.
 */
import { runLeadLeaks } from '@aac/lead-leaks';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { createLogger } from '@aac/shared-utils/logger';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys } from '@aac/shared-utils/redis';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-lead-leaks');

/** Stop starting new threads this long into the run (maxDuration is 800s); the rest wait for tomorrow. */
const BUDGET_MS = 600_000;

export async function GET(request: Request): Promise<Response> {
  return guarded('lead-leaks', () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const fromMiddleware = isMiddlewareRequest(request);
  if (!isCronRequest(request) && !fromMiddleware) {
    return json({ error: 'unauthorized' }, 401);
  }
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) return json({ status: 'ok', skipped: 'no-google-env' });
  const { deps, redis } = getWorkerDeps();
  const started = Date.now();
  const today = easternDate(started);
  const force = fromMiddleware && new URL(request.url).searchParams.get('force') === '1';
  const last = await redis.get<{ day: string }>(keys.leadLeaksLastRun);
  if (!force && last?.day === today) return json({ status: 'ok', skipped: 'done-today' });
  if (!(await redis.set(keys.leadLeaksRunLock, String(started), { nx: true, ex: 900 }))) {
    return json({ status: 'ok', skipped: 'locked' });
  }
  try {
    const snap = await runLeadLeaks(
      {
        redis,
        quo: deps.quo,
        qb: deps.qb,
        calendar: new GoogleCalendarClient({
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
          oauth: { clientId, clientSecret, refreshToken },
        }),
        gemini: deps.gemini,
        ownLine: process.env.QUO_PHONE_NUMBER ?? '',
        keys: { snapshot: keys.leadLeaks, verdicts: keys.leadLeakVerdicts },
      },
      { now: new Date(started), deadlineMs: started + BUDGET_MS },
    );
    const summary = {
      day: today,
      at: new Date(started).toISOString(),
      threads: snap.threads,
      llmCalls: snap.llmCalls,
      leaks: snap.rows.length,
      partial: snap.partial,
      gaps: snap.gaps,
    };
    // A partial run leaves its day unset so the next slot (or tomorrow) finishes the reads.
    if (!snap.partial) await redis.set(keys.leadLeaksLastRun, JSON.stringify(summary));
    log.info('lead-leaks run', summary);
    await recordRun('lead-leaks', { sent: snap.rows.length, skipped: snap.threads - snap.rows.length, errors: snap.gaps.length });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('lead-leaks failed', err as Error);
    await recordFailure('lead-leaks', `lead-leaks failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  } finally {
    await redis.del(keys.leadLeaksRunLock);
  }
}
