/**
 * QB Reconciliation Cron — Crawl-stage backstop for the scheduling
 * directive pipeline.
 *
 * Intuit doesn't guarantee delivery. If a QB webhook is missed (network
 * blip, ACL drift, or a flip that occurred before /api/qb-webhook was
 * live), the SchedulingDirective for that estimate never gets created
 * and Matt never sees it on /scheduling.
 *
 * This cron sweeps the last `windowDays` of Estimates via
 * `qb.listRecentEstimates(sinceISO)`, filters client-side to Accepted,
 * skips any estimate already directive-ized (`scheduling:directive-by-
 * qb-estimate:{id}`), and replays the missing ones through the same
 * `normalizeQbApproval` the webhook uses — with `source: 'qb_reconciliation'`
 * for traceability.
 *
 * Schedule: daily ~9am ET (after deal-reconcile).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { createLogger } from '@aac/shared-utils/logger';
import { normalizeQbApproval } from '@aac/scheduling';
import { getPipedrive, getQuickBooks, getQuo } from '../../lib/clients.js';
import { verifyCronAuth } from '../../lib/cron.js';
import {
  getDirectiveIdByEstimate,
  logHealthError,
  trackCronRun,
  writePendingDirective,
} from '../../lib/redis.js';

const log = createLogger('cron:qb-reconcile');

const DEFAULT_WINDOW_DAYS = 7;

interface ReconcileSummary {
  scanned: number;
  accepted: number;
  alreadyDirectived: number;
  directivesCreated: number;
  filtered: number;
  errors: number;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!verifyCronAuth(req, res)) return;

  const requested = parseInt((req.query.windowDays as string) ?? '', 10);
  const windowDays =
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WINDOW_DAYS;

  const summary: ReconcileSummary = {
    scanned: 0,
    accepted: 0,
    alreadyDirectived: 0,
    directivesCreated: 0,
    filtered: 0,
    errors: 0,
  };

  try {
    const qb = getQuickBooks();
    if (!(await qb.isConnected())) {
      log.warn('QuickBooks not connected; qb-reconcile skipped');
      res.status(200).json({ status: 'skipped', reason: 'qb_not_connected' });
      return;
    }

    const sinceISODate = isoDateNDaysAgo(windowDays);
    const estimates = await qb.listRecentEstimates(sinceISODate);
    summary.scanned = estimates.length;

    const pd = getPipedrive();
    const quo = getQuo();

    for (const estimate of estimates) {
      if (estimate.TxnStatus !== 'Accepted') continue;
      summary.accepted++;

      try {
        const existing = await getDirectiveIdByEstimate(estimate.Id);
        if (existing) {
          summary.alreadyDirectived++;
          continue;
        }

        const directive = await normalizeQbApproval(
          {
            pd,
            qb,
            quo,
            newId: () => randomUUID(),
            now: () => new Date(),
          },
          { estimate, source: 'qb_reconciliation' },
        );

        if (!directive) {
          // normalizeQbApproval returns null if TxnStatus moved off Accepted
          // between the list call and the per-estimate get inside the normalizer.
          summary.filtered++;
          continue;
        }

        await writePendingDirective(directive);
        summary.directivesCreated++;
        log.info('Reconciliation created directive', {
          directiveId: directive.id,
          estimateId: directive.qbEstimateId,
          confidence: directive.confidence.score,
        });
      } catch (err) {
        summary.errors++;
        log.error('Failed to reconcile estimate', err as Error, {
          estimateId: estimate.Id,
        });
        await logHealthError('qb-reconcile', (err as Error).message, {
          estimateId: estimate.Id,
        });
      }
    }

    await trackCronRun('qb-reconcile', {
      sent: summary.directivesCreated,
      skipped: summary.alreadyDirectived + summary.filtered,
      errors: summary.errors,
    });

    log.info('QB reconcile run complete', { windowDays, summary });
    res.status(200).json({ status: 'ok', windowDays, summary });
  } catch (error) {
    const err = error as Error;
    log.error('QB reconcile failed', err);
    await logHealthError('qb-reconcile', err.message, { windowDays: String(windowDays) });
    await trackCronRun('qb-reconcile', { sent: 0, skipped: 0, errors: 1 });
    res.status(200).json({ status: 'error', message: err.message });
  }
}

function isoDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}
