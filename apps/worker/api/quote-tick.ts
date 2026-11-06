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
 *
 * Heartbeat `health:quote-drafter:ts` only after a tick that ran (not off,
 * locked or no-assets); skips go to the streak in lib/quote-skip.ts.
 *
 * With `quote` in Redis `inbound-router:live`, the inbound router judges
 * the customer's texts, photos and voicemails and hands its quote decisions
 * over as routed jobs; this loop drops those events and keeps Matt's own
 * texts (T3), emails, call transcripts and Mike's debriefs (T2).
 */
import { createLogger } from '@aac/shared-utils/logger';
import { writeHeartbeat } from '@aac/shared-utils/health';
import { runTick } from '@aac/quote-drafter';
import { liveRoutes } from '@aac/inbound-router';
import { getQuoteDeps, envMode } from '../lib/quote-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { recordFailure } from '../lib/health.js';
import { trackQuoteTickSkip } from '../lib/quote-skip.js';

const log = createLogger('worker-quote-tick');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const deps = getQuoteDeps();
    const routerOwnsInbound = (await liveRoutes(deps)).has('quote');
    const summary = await runTick(deps, envMode(), { routerOwnsInbound });
    // The heartbeat means a tick ran; a skipped one (off, run lock taken,
    // no asset manifest) only extends the skip streak the watchdog reads.
    if (!summary.skipped) await writeHeartbeat(deps.redis, 'quote-drafter');
    await trackQuoteTickSkip(deps.redis, summary);
    if (summary.skipped === 'no-assets') {
      await recordFailure('quote-tick', 'quote drafter skipped: no asset manifest in Redis (run sync-assets)');
    }
    // The drafter swallows a failed draft into a 'failed' record.
    const failed = summary.records.filter((r) => r.record?.outcome === 'failed');
    if (failed.length) {
      await recordFailure('quote-tick', `quote drafter: ${failed.length} draft(s) failed`, {
        failed: failed.slice(0, 5).map((r) => ({ phone: r.phone, trigger: r.trigger, detail: r.record?.detail?.slice(0, 200) ?? null })),
      });
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
    await recordFailure('quote-tick', `quote tick failed: ${(err as Error).message}`);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
