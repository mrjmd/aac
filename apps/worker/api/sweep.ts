/**
 * 10-minute backstop sweep (route: /api/sweep, Vercel cron): 36h QBO
 * estimate lookback + 6h Quo conversation poll — catches anything the
 * event-driven paths missed. Identical code path to the laptop runner.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { MAX_DRAFTS_PER_RUN, sweepFollowups, sweepIntake } from '@aac/message-drafts';
import { liveRoutes, sweepInbound } from '@aac/inbound-router';
import { CanHelpStore } from '@aac/quoting';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-sweep');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const { deps, redis } = getWorkerDeps();
    const firstRunAt = await deps.state.getFirstRunAt();
    const firstRun = !firstRunAt;
    if (firstRun) await deps.state.setFirstRunAt(new Date().toISOString());
    const records = [...(await sweepFollowups(deps, { maxDrafts: MAX_DRAFTS_PER_RUN, firstRun }))];
    // Once the inbound router owns intake, the backstop re-arms the router
    // for missed customer messages instead of drafting intake itself.
    if ((await liveRoutes({ redis })).has('intake')) {
      const armed = await sweepInbound({ redis, quo: deps.quo, gemini: deps.gemini, canHelp: new CanHelpStore(redis) });
      if (armed.length) log.info('sweep re-armed inbound router', { armed: armed.length });
    } else {
      records.push(...(await sweepIntake(deps, { maxDrafts: MAX_DRAFTS_PER_RUN })));
    }
    const drafted = records.filter((r) => r.outcome === 'drafted').length;
    if (records.length) log.info('sweep complete', { drafted, records: records.length });
    await recordRun('sweep', { sent: drafted, skipped: records.length - drafted, errors: 0 });
    return json({ status: 'ok', drafted, records: records.length });
  } catch (err) {
    log.error('sweep failed', err as Error);
    await recordFailure('sweep', `sweep failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
