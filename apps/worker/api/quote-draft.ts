/**
 * Manual one-phone draft (route: /api/quote-draft, POST, synchronous).
 *
 * Operational escape hatch + validation probe: draft (or dry-run) a
 * single customer right now, bypassing the trigger queue. Body:
 *   { phone: "+1508...", name?: "Jane Doe", dryRun?: true,
 *     skipIfRecentEstimateDays?: 30 }
 *
 * Same guards as the trigger path (phone-first resolution, SyncToken
 * ownership, human-owned skip); hasNewInbound=true because a human asked.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { draftOne, loadAssets, loadFieldChannel, prepareRun } from '@aac/quote-drafter';
import { getQuoteDeps } from '../lib/quote-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-quote-draft');

export async function POST(request: Request): Promise<Response> {
  if (!isMiddlewareRequest(request) && !isCronRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body: { phone?: string; name?: string; dryRun?: boolean; skipIfRecentEstimateDays?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.phone || !/^\+1\d{10}$/.test(body.phone)) {
    return json({ error: 'phone must be E.164 (+1XXXXXXXXXX)' }, 400);
  }

  try {
    const deps = getQuoteDeps();
    const assets = await loadAssets(deps.redis);
    if (!assets) {
      return json({ status: 'error', message: 'no asset manifest in Redis — run sync-assets' }, 409);
    }
    const run = await prepareRun(deps);
    const fieldChannel = await loadFieldChannel(deps);
    const record = await draftOne(deps, {
      finding: { phone: body.phone, customer: body.name ?? null, title: `manual draft for ${body.phone}` },
      run,
      assets,
      fieldChannel,
      dryRun: body.dryRun ?? false,
      skipIfRecentEstimateDays: body.skipIfRecentEstimateDays,
      hasNewInbound: true,
    });
    log.info('manual draft', { phone: body.phone, outcome: record.outcome, detail: record.detail });
    return json({ status: 'ok', record: { ...record } });
  } catch (err) {
    log.error('manual draft failed', err as Error, { phone: body.phone });
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
