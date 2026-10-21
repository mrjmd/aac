/**
 * 10-minute backstop sweep (route: /api/sweep, Vercel cron): 36h QBO
 * estimate lookback + 6h Quo conversation poll — catches anything the
 * event-driven paths missed. Identical code path to the laptop runner.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { MAX_DRAFTS_PER_RUN, sweepFollowups, sweepIntake } from '@aac/message-drafts';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-sweep');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const { deps } = getWorkerDeps();
  try {
    const firstRunAt = await deps.state.getFirstRunAt();
    const firstRun = !firstRunAt;
    if (firstRun) await deps.state.setFirstRunAt(new Date().toISOString());
    const records = [
      ...(await sweepFollowups(deps, { maxDrafts: MAX_DRAFTS_PER_RUN, firstRun })),
      ...(await sweepIntake(deps, { maxDrafts: MAX_DRAFTS_PER_RUN })),
    ];
    const drafted = records.filter((r) => r.outcome === 'drafted').length;
    if (records.length) log.info('sweep complete', { drafted, records: records.length });
    return json({ status: 'ok', drafted, records: records.length });
  } catch (err) {
    log.error('sweep failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
