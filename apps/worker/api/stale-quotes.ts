/**
 * Stale-quote follow-up (route: /api/stale-quotes, Vercel cron every 20 min
 * through the 12:00 UTC hour). One full scan per Eastern day: the first
 * slot runs it, later slots finish a scan the time budget cut short, then
 * skip. Drafts are Quo copy/paste notes; nothing is ever sent.
 *
 * Gated by Redis `stale-quotes:mode` (off | dry | live, unset = off). Dry
 * refreshes only the awaiting-reply list. `?force=1` (middleware secret)
 * runs again today.
 */
import { runStaleQuotes } from '@aac/stale-quotes';
import { createLogger } from '@aac/shared-utils/logger';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys } from '@aac/shared-utils/redis';
import { getWorkerDeps } from '../lib/deps.js';
import { getStaleQuoteDeps, staleQuotesMode } from '../lib/stale-quotes-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-stale-quotes');

/** Stop starting new quotes this long into the run (maxDuration is 800s). */
const BUDGET_MS = 600_000;

interface LastRun {
  day: string;
  mode: string;
  partial: boolean;
}

export async function GET(request: Request): Promise<Response> {
  return guarded('stale-quotes', () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const fromMiddleware = isMiddlewareRequest(request);
  if (!isCronRequest(request) && !fromMiddleware) {
    return json({ error: 'unauthorized' }, 401);
  }
  const mode = await staleQuotesMode();
  if (mode === 'off') return json({ status: 'ok', skipped: 'off' });
  const deps = getStaleQuoteDeps();
  if (!deps) {
    log.warn('stale quotes disabled — Google env not set');
    return json({ status: 'ok', skipped: 'no-google-env' });
  }
  const { redis } = getWorkerDeps();
  const started = Date.now();
  const today = easternDate(started);
  const force = fromMiddleware && new URL(request.url).searchParams.get('force') === '1';
  const last = await redis.get<LastRun>(keys.staleQuotesLastRun);
  if (!force && last?.day === today && last.mode === mode && !last.partial) {
    return json({ status: 'ok', skipped: 'done-today' });
  }
  if (!(await redis.set(keys.staleQuotesRunLock, String(started), { nx: true, ex: 900 }))) {
    return json({ status: 'ok', skipped: 'locked' });
  }
  try {
    const r = await runStaleQuotes(deps, { dryRun: mode === 'dry', deadlineMs: started + BUDGET_MS });
    const summary = {
      day: today,
      mode,
      partial: r.partial,
      at: new Date().toISOString(),
      pending: r.pendingInScope,
      drafted: r.queue.toSend.length,
      waiting: r.queue.waiting.length,
      flags: r.queue.flags.length,
      awaiting: r.awaiting.length,
      skipped: r.queue.skipped.length,
    };
    await redis.set(keys.staleQuotesLastRun, JSON.stringify(summary));
    log.info('stale quotes run', summary);
    await recordRun('stale-quotes', { sent: summary.drafted, skipped: summary.skipped, errors: 0 });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('stale quotes failed', err as Error);
    await recordFailure('stale-quotes', `stale quotes failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  } finally {
    await redis.del(keys.staleQuotesRunLock);
  }
}
