/**
 * Fast-lane follow-up draft (route: /api/draft-followup).
 *
 * POSTed by the middleware qb-webhook (x-worker-secret) the moment an
 * estimate.emailed event lands, so the "just sent that quote over" note
 * is on the Quo contact seconds later instead of waiting on a tick.
 * Body: { estimateId: string }. Re-validates EmailSent+Pending and the
 * Redis claim, so duplicate or stale invocations are no-ops.
 */
import { waitUntil } from '@vercel/functions';
import { createLogger } from '@aac/shared-utils/logger';
import { processFollowupById } from '@aac/message-drafts';
import { getWorkerDeps } from '../lib/deps.js';
import { isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-draft-followup');

/** Keep working after the response goes out; detached fallback outside Vercel. */
function defer(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    void work.catch(() => {});
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isMiddlewareRequest(request)) return json({ error: 'unauthorized' }, 401);
  let estimateId: string;
  let sync = false;
  try {
    const body = (await request.json()) as { estimateId?: unknown; sync?: unknown };
    estimateId = String(body.estimateId ?? '');
    sync = body.sync === true;
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!estimateId) return json({ error: 'estimateId required' }, 400);

  const { deps } = getWorkerDeps();
  const work = (async () => {
    try {
      const record = await processFollowupById(deps, estimateId);
      log.info('fast-lane follow-up processed', { estimateId, outcome: record?.outcome ?? 'noop' });
      return record;
    } catch (err) {
      log.error('fast-lane follow-up failed', err as Error, { estimateId });
      throw err;
    }
  })();

  if (sync) {
    try {
      const record = await work;
      return json({ status: 'ok', outcome: record?.outcome ?? 'noop' });
    } catch (err) {
      return json({ status: 'error', message: (err as Error).message }, 500);
    }
  }
  // Ack in milliseconds so the middleware webhook never waits on Gemini;
  // the draft itself finishes via waitUntil (sweep backstops any failure).
  defer(work);
  return json({ status: 'accepted', estimateId }, 202);
}
