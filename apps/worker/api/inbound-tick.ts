/**
 * Per-minute inbound router pass (route: /api/inbound-tick, Vercel cron).
 *
 * Off by default (docs/plans/inbound-router.md): clears settled bursts
 * unread. Redis `inbound-router:mode` = 'shadow' (no redeploy) reads each
 * settled customer burst once and logs which drafters it would run to
 * `inbound:shadow`, next to what the old paths did, posting nothing. Routes
 * in Redis `inbound-router:live` (phase 4) also run their drafters; /api/tick
 * and /api/sweep turn the matching old path off.
 * Cheap when idle: one GET (mode) + one ZRANGEBYSCORE.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { runInboundTick } from '@aac/inbound-router';
import { CanHelpStore } from '@aac/quoting';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-inbound-tick');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const { deps, redis } = getWorkerDeps();
  try {
    const summary = await runInboundTick({
      redis,
      quo: deps.quo,
      gemini: deps.gemini,
      canHelp: new CanHelpStore(redis),
      drafts: deps,
    });
    for (const e of summary.entries) {
      log.info('inbound route', {
        phone: e.phone,
        outcome: e.outcome,
        routes: e.routes?.map((r) => r.route).join(',') ?? null,
        verdict: e.read?.verdict ?? null,
        legacyIntake: e.legacy?.intake ?? null,
        acted: e.acted?.map((a) => `${a.route}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`).join(',') ?? null,
        detail: e.detail ?? null,
      });
    }
    return json({ status: 'ok', mode: summary.mode, due: summary.due, read: summary.entries.length });
  } catch (err) {
    log.error('inbound tick failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
