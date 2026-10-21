/**
 * Per-minute quote-trigger pass (route: /api/quote-tick, Vercel cron).
 *
 * Cheap when idle: one queue drain + one ZRANGEBYSCORE on the debounce
 * clock. When a phone's 15-min settle window has closed it classifies
 * (T1/T2/T3) and runs the drafter — Pending QBO estimate + 🤖 Quo note,
 * never anything customer-facing. A Redis NX lock serializes overlapping
 * ticks (estimate doc numbers must not race).
 *
 * Mode: Redis `quote-drafter:mode` overrides QUOTE_DRAFTER_MODE
 * (off | shadow | live); off short-circuits before touching the queue.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';
import { runTick } from '@aac/quote-drafter';
import { getQuoteDeps, envMode } from '../lib/quote-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-quote-tick');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const deps = getQuoteDeps();
    const summary = await runTick(deps, envMode());
    if (summary.mode !== 'off') {
      await deps.redis.set(keys.heartbeat('quote-drafter'), new Date().toISOString());
    }
    if (summary.drafted || summary.drained) {
      log.info('quote tick', {
        mode: summary.mode,
        drained: summary.drained,
        due: summary.due,
        settling: summary.settling,
        drafted: summary.drafted,
        outcomes: summary.records.map((r) => `${r.phone}:${r.trigger}:${r.record?.outcome ?? 'n/a'}`),
      });
    }
    return json({
      status: 'ok',
      mode: summary.mode,
      skipped: summary.skipped ?? null,
      drained: summary.drained,
      due: summary.due,
      settling: summary.settling,
      drafted: summary.drafted,
    });
  } catch (err) {
    log.error('quote tick failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
