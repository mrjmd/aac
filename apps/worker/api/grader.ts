/**
 * Daily draft grader (route: /api/grader, Vercel cron 13:30 UTC, after
 * triage). Copies every new draft from the quote drafter, message-drafts and
 * stale-quote logs into its own record, then grades the ones still waiting
 * against what Matt actually sent (`@aac/grader`). Reads QBO and Quo; writes
 * only `grader:drafts`. Sends nothing.
 *
 * Gated by Redis `grader:mode` (off | dry | live, unset = off). Dry grades
 * without writing records. `?force=1` (middleware secret) runs again today.
 */
import { runGrader } from '@aac/grader';
import { createLogger } from '@aac/shared-utils/logger';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys } from '@aac/shared-utils/redis';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-grader');

/** Stop grading this long into the run (maxDuration is 800s); the rest wait for tomorrow. */
const BUDGET_MS = 600_000;

type GraderMode = 'off' | 'dry' | 'live';

interface LastRun {
  day: string;
  mode: string;
}

export async function GET(request: Request): Promise<Response> {
  return guarded('grader', () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const fromMiddleware = isMiddlewareRequest(request);
  if (!isCronRequest(request) && !fromMiddleware) {
    return json({ error: 'unauthorized' }, 401);
  }
  const { deps, redis } = getWorkerDeps();
  const m = await redis.get<string>(keys.graderMode);
  const mode: GraderMode = m === 'dry' || m === 'live' ? m : 'off';
  if (mode === 'off') return json({ status: 'ok', skipped: 'off' });
  const started = Date.now();
  const today = easternDate(started);
  const force = fromMiddleware && new URL(request.url).searchParams.get('force') === '1';
  const last = await redis.get<LastRun>(keys.graderLastRun);
  if (!force && last?.day === today && last.mode === mode) {
    return json({ status: 'ok', skipped: 'done-today' });
  }
  if (!(await redis.set(keys.graderRunLock, String(started), { nx: true, ex: 900 }))) {
    return json({ status: 'ok', skipped: 'locked' });
  }
  try {
    const r = await runGrader(
      { redis, qb: deps.qb, quo: deps.quo, log: (line) => log.info(line) },
      { dryRun: mode === 'dry', deadlineMs: started + BUDGET_MS },
    );
    const summary = { day: today, mode, at: new Date().toISOString(), ...r };
    await redis.set(keys.graderLastRun, JSON.stringify(summary));
    log.info('grader run', summary);
    await recordRun('grader', { sent: r.graded, skipped: r.byGrade.waiting, errors: r.errors });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('grader failed', err as Error);
    await recordFailure('grader', `grader failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  } finally {
    await redis.del(keys.graderRunLock);
  }
}
