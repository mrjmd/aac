/**
 * Daily triage (route: /api/triage, Vercel cron 13:05 UTC, after the
 * stale-quote scan's 12:00-12:40 slots so it reads that morning's queue).
 * Runs @aac/triage collect → analyze → triageCandidates and, in live mode,
 * publishes the command-center item candidates with source
 * `triage-worker`. Replaces the laptop's com.aac.triage launchd run
 * (docs/plans/triage-to-worker.md, cleanup step 3b).
 *
 * Gated by Redis `triage:mode` (off | dry | live, unset = off). Dry runs
 * the whole pipeline and records counts only. Once per Eastern day per
 * mode; `?force=1` (middleware secret) runs again today.
 *
 * analyze can't resume a cut-short run, so there is one slot and a
 * deadline: past BUDGET_MS the run is abandoned unpublished, recorded as a
 * health error, and the lock released (tomorrow's slot, or a forced run,
 * tries again).
 */
import { randomUUID } from 'node:crypto';
import { publishTriageItems } from '@aac/triage';
import { createLogger } from '@aac/shared-utils/logger';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys } from '@aac/shared-utils/redis';
import { getTriageDeps, missingTriageEnv, triageMode } from '../lib/triage-deps.js';
import { countBy, runTriage, withDeadline } from '../lib/triage-run.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-triage');

/** Abandon the run this long in (maxDuration is 800s; the rest records + releases). */
const BUDGET_MS = 720_000;
/** Lock TTL outlives maxDuration, so a killed run's lock still expires before tomorrow. */
const LOCK_TTL_SEC = 900;

/** Compare-and-delete: release the run lock only if this run still owns it. */
const RELEASE_LOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

interface LastRun {
  day: string;
  mode: string;
}

export async function GET(request: Request): Promise<Response> {
  return guarded('triage', () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const fromMiddleware = isMiddlewareRequest(request);
  if (!isCronRequest(request) && !fromMiddleware) {
    return json({ error: 'unauthorized' }, 401);
  }
  const missing = missingTriageEnv();
  if (missing) return json({ status: 'ok', skipped: missing });
  const mode = await triageMode();
  if (mode === 'off') return json({ status: 'ok', skipped: 'off' });
  const deps = getTriageDeps();
  const { redis } = deps;
  const started = Date.now();
  const today = easternDate(started);
  const force = fromMiddleware && new URL(request.url).searchParams.get('force') === '1';
  const last = await redis.get<LastRun>(keys.triageLastRun);
  if (!force && last?.day === today && last.mode === mode) {
    return json({ status: 'ok', skipped: 'done-today' });
  }
  const token = randomUUID();
  if (!(await redis.set(keys.triageRunLock, token, { nx: true, ex: LOCK_TTL_SEC }))) {
    return json({ status: 'ok', skipped: 'locked' });
  }
  try {
    const r = await withDeadline(runTriage(deps), BUDGET_MS);
    const live = mode === 'live';
    if (live) {
      await publishTriageItems({ redis }, { at: r.data.generatedAt, source: 'triage-worker', candidates: r.candidates });
    }
    const stats = r.data.stats;
    const summary = {
      day: today,
      mode,
      at: new Date().toISOString(),
      generatedAt: r.data.generatedAt,
      durationMs: Date.now() - started,
      collectMs: r.collectMs,
      analyzeMs: r.analyzeMs,
      findings: r.data.findings.length,
      bySection: countBy(r.data.findings, (f) => f.section),
      candidates: r.candidates.length,
      byDetector: countBy(r.candidates, (c) => c.detector),
      published: live,
      llmErrors: stats.llmErrors ?? 0,
      emailSweepOk: stats.emailSweepOk ?? 0,
      geminiCanaryOk: stats.geminiCanaryOk ?? 0,
    };
    await redis.set(keys.triageLastRun, JSON.stringify(summary));
    log.info('triage run', summary);
    // Swallowed failures: the run finished, but part of it was blind.
    const blind = [
      summary.llmErrors ? `${summary.llmErrors} LLM errors` : '',
      summary.emailSweepOk ? '' : 'email sweep failed',
      summary.geminiCanaryOk ? '' : 'Gemini canary failed',
    ].filter(Boolean);
    if (blind.length) await recordFailure('triage', `triage run degraded: ${blind.join(', ')}`);
    await recordRun('triage', { sent: live ? summary.candidates : 0, skipped: 0, errors: summary.llmErrors });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('triage failed', err as Error);
    await recordFailure('triage', `triage failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  } finally {
    await releaseLock(redis, token);
  }
}

/** Never throws: the TTL is the backstop. */
async function releaseLock(redis: ReturnType<typeof getTriageDeps>['redis'], token: string): Promise<void> {
  try {
    const released = await redis.eval(RELEASE_LOCK_LUA, [keys.triageRunLock], [token]);
    if (released !== 1) log.warn('triage run lock no longer ours at release (expired or taken), left alone');
  } catch (err) {
    log.warn(`triage run lock release failed (TTL will expire it): ${(err as Error).message.slice(0, 120)}`);
  }
}
