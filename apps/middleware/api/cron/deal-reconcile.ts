/**
 * Deal Reconcile Cron — nightly sweep that converges PD deal state with
 * QB estimate + invoice state. Catches anything the deterministic write
 * paths (Quo webhook inbound-lead stamp, deal-aware crons, future QB
 * webhooks) didn't already stamp.
 *
 * Replays the last `windowDays` of QB activity and:
 *  - Creates a PD deal at Quote Sent / Quote Accepted for each QB estimate
 *    with no matching deal (dedup via external_id = qb-est-{id}).
 *  - Advances deal stage when QB shows the estimate further along than PD.
 *  - Links invoices to their underlying deal (direct external_id, then via
 *    the linked estimate). Stamps qb_invoice_id when missing.
 *  - Advances to Paid when invoice Balance reaches zero.
 *
 * Never demotes — the reconcile is monotonic forward through the lifecycle.
 * Lost deals are skipped (treated as past-terminal by isStageAdvance).
 *
 * Schedule: daily ~9am ET (after the morning operational crons).
 * Dry run not implemented yet — algorithm only writes when state diverges,
 * so a clean second run after a real run is a no-op.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getPipedrive, getQuickBooks } from '../../lib/clients.js';
import { verifyCronAuth } from '../../lib/cron.js';
import { reconcileDeals } from '../../lib/deal-reconcile.js';
import { getPipedriveIdFromQb, logHealthError, trackCronRun } from '../../lib/redis.js';

const log = createLogger('cron:deal-reconcile');

const DEFAULT_WINDOW_DAYS = 7;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!verifyCronAuth(req, res)) return;

  const requestedWindow = parseInt((req.query.windowDays as string) ?? '', 10);
  const windowDays = Number.isFinite(requestedWindow) && requestedWindow > 0
    ? requestedWindow
    : DEFAULT_WINDOW_DAYS;

  try {
    const pipedrive = getPipedrive();
    const quickbooks = getQuickBooks();

    const qbConnected = await quickbooks.isConnected();
    if (!qbConnected) {
      log.warn('QuickBooks not connected; deal reconcile skipped');
      res.status(200).json({ status: 'skipped', reason: 'qb_not_connected' });
      return;
    }

    const summary = await reconcileDeals(
      {
        pipedrive,
        quickbooks,
        resolvePdPersonId: getPipedriveIdFromQb,
      },
      windowDays,
    );

    const sent =
      summary.estimates.dealsCreated +
      summary.estimates.stagesAdvanced +
      summary.invoices.dealsCreated +
      summary.invoices.stagesAdvanced +
      summary.invoices.invoicesLinked;
    const skipped =
      summary.estimates.skippedNoMapping +
      summary.estimates.skippedTerminal +
      summary.invoices.skippedNoMapping;

    await trackCronRun('deal-reconcile', { sent, skipped, errors: 0 });

    log.info('Deal reconcile run complete', { windowDays, summary });
    res.status(200).json({ status: 'ok', windowDays, summary });
  } catch (error) {
    const err = error as Error;
    log.error('Deal reconcile failed', err);
    await logHealthError('deal-reconcile', err.message, {
      windowDays: String(windowDays),
    });
    await trackCronRun('deal-reconcile', { sent: 0, skipped: 0, errors: 1 });
    res.status(200).json({ status: 'error', message: err.message });
  }
}
