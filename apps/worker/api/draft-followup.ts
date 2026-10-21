/**
 * Fast-lane follow-up draft (route: /api/draft-followup).
 *
 * POSTed by the middleware qb-webhook (x-worker-secret) the moment an
 * estimate.emailed event lands, so the "just sent that quote over" note
 * is on the Quo contact seconds later instead of waiting on a tick.
 * Body: { estimateId: string }. Re-validates EmailSent+Pending and the
 * Redis claim, so duplicate or stale invocations are no-ops.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { processFollowupById } from '@aac/message-drafts';
import { getWorkerDeps } from '../lib/deps.js';
import { isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-draft-followup');

export async function POST(request: Request): Promise<Response> {
  if (!isMiddlewareRequest(request)) return json({ error: 'unauthorized' }, 401);
  let estimateId: string;
  try {
    const body = (await request.json()) as { estimateId?: unknown };
    estimateId = String(body.estimateId ?? '');
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!estimateId) return json({ error: 'estimateId required' }, 400);

  const { deps } = getWorkerDeps();
  try {
    const record = await processFollowupById(deps, estimateId);
    log.info('fast-lane follow-up processed', { estimateId, outcome: record?.outcome ?? 'noop' });
    return json({ status: 'ok', outcome: record?.outcome ?? 'noop' });
  } catch (err) {
    log.error('fast-lane follow-up failed', err as Error, { estimateId });
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
