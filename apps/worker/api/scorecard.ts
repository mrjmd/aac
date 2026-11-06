/**
 * Nightly weekly scorecard (route: /api/scorecard, Vercel cron 09:00 UTC,
 * before the morning). Brings the lead cache up to date from Quo, reads
 * QBO, the calendar and Google Ads, and saves every row for the command
 * center's This week (`@aac/metrics` runScorecard). Writes only
 * `scorecard:*`. Sends nothing.
 *
 * Once per Eastern day; `?force=1` (middleware secret) runs again.
 */
import { runScorecard } from '@aac/metrics';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { technicianEmails } from '@aac/shared-utils/calendar';
import { createLogger } from '@aac/shared-utils/logger';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys } from '@aac/shared-utils/redis';
import { adsClient } from '../lib/ads-deps.js';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-scorecard');

/** Stop reading new Quo threads this long into the run (maxDuration is 800s); the rest wait for tomorrow. */
const BUDGET_MS = 500_000;
/** The funnel study's lead ledger (the seed) runs through 11/02; overlap it on the first run. */
const FIRST_LEADS_SINCE = '2026-10-25T00:00:00Z';
/** Re-read threads from a day before the last run, so a late write isn't missed. */
const OVERLAP_MS = 86_400_000;

interface LastRun {
  day: string;
  at: string;
}

export async function GET(request: Request): Promise<Response> {
  return guarded('scorecard', () => handle(request));
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
  const last = await redis.get<LastRun>(keys.scorecardLastRun);
  if (!force && last?.day === today) return json({ status: 'ok', skipped: 'done-today' });
  if (!(await redis.set(keys.scorecardRunLock, String(started), { nx: true, ex: 900 }))) {
    return json({ status: 'ok', skipped: 'locked' });
  }
  try {
    const r = await runScorecard(
      {
        redis,
        qb: deps.qb,
        quo: deps.quo,
        calendar: new GoogleCalendarClient({
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
          oauth: { clientId, clientSecret, refreshToken },
        }),
        ads: adsClient(),
        techEmails: technicianEmails(process.env.TECHNICIAN_EMAILS),
        ownLine: process.env.QUO_PHONE_NUMBER ?? '',
        keys: { scorecard: keys.scorecard, leads: keys.scorecardLeads },
      },
      {
        now: new Date(started),
        leadsSince: new Date(last?.at ? Date.parse(last.at) - OVERLAP_MS : Date.parse(FIRST_LEADS_SINCE)),
        deadlineMs: started + BUDGET_MS,
      },
    );
    const summary = {
      day: today,
      at: new Date(started).toISOString(),
      leadsChecked: r.leadsChecked,
      leadsAdded: r.leadsAdded,
      partial: r.partial,
      gaps: r.scorecard.gaps,
    };
    // A partial lead pass keeps the old cursor, so tomorrow picks up the threads it skipped.
    const cursor = r.partial ? (last?.at ?? FIRST_LEADS_SINCE) : summary.at;
    await redis.set(keys.scorecardLastRun, JSON.stringify({ ...summary, at: cursor }));
    log.info('scorecard run', summary);
    await recordRun('scorecard', { sent: r.scorecard.rows.length, skipped: 0, errors: r.scorecard.gaps.length });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('scorecard failed', err as Error);
    await recordFailure('scorecard', `scorecard failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  } finally {
    await redis.del(keys.scorecardRunLock);
  }
}
