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
 * Schedule: every 30 min (was daily ~9am ET; tightened 2026-10-21 after
 * the John Skinner approval — Intuit fired NO webhook for the estimate
 * acceptance even though delivery was verified healthy minutes later, so
 * this backstop is the only guaranteed path for approvals and a daily
 * cadence left an accepted quote invisible for up to 24h).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { createLogger } from '@aac/shared-utils/logger';
import { normalizeQbApproval, summaryMatchesCustomer } from '@aac/scheduling';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { getCalendar, getPipedrive, getQuickBooks, getQuo } from '../../lib/clients.js';
import { verifyCronAuth } from '../../lib/cron.js';
import { maybePostSuggestionNote } from '../../lib/suggestion-note.js';
import {
  getDirectiveIdByEstimate,
  logHealthError,
  markEstimateHandled,
  trackCronRun,
  writePendingDirective,
} from '../../lib/redis.js';

const log = createLogger('cron:qb-reconcile');

const DEFAULT_WINDOW_DAYS = 7;

interface ReconcileSummary {
  scanned: number;
  accepted: number;
  alreadyDirectived: number;
  /** Customer already has an upcoming calendar event — Matt scheduled by hand. */
  manuallyScheduled: number;
  directivesCreated: number;
  filtered: number;
  errors: number;
}

/** How far ahead to look for a manually-created event for the customer. */
const MANUAL_SCHEDULE_LOOKAHEAD_DAYS = 60;

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
    manuallyScheduled: 0,
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

    // Walk #7 prereq 1: if the QB webhook was missed and Matt hand-scheduled
    // the job, the reverse index is empty but the work IS on the calendar.
    // Fetch upcoming events once per run and name-match per estimate. A
    // calendar failure degrades to the old behavior (guard disabled).
    let upcomingEvents: CalendarEvent[] | null = null;
    try {
      const now = new Date();
      upcomingEvents = await getCalendar().listEvents({
        timeMin: now.toISOString(),
        timeMax: new Date(
          now.getTime() + MANUAL_SCHEDULE_LOOKAHEAD_DAYS * 86_400_000,
        ).toISOString(),
        maxResults: 500,
      });
    } catch (err) {
      log.warn('Calendar unavailable — manual-schedule guard disabled this run', {
        error: (err as Error).message,
      });
    }

    for (const estimate of estimates) {
      if (estimate.TxnStatus !== 'Accepted') continue;
      summary.accepted++;

      try {
        const existing = await getDirectiveIdByEstimate(estimate.Id);
        if (existing) {
          summary.alreadyDirectived++;
          continue;
        }

        const customerName = estimate.CustomerRef?.name ?? '';
        const booked = upcomingEvents?.find((e) =>
          summaryMatchesCustomer(e.summary, customerName),
        );
        if (booked) {
          // Stamp the reverse index so later runs short-circuit on Redis.
          await markEstimateHandled(estimate.Id, `manual-scheduled:${booked.id}`);
          summary.manuallyScheduled++;
          log.info('Estimate already on calendar — skipped (manual schedule)', {
            estimateId: estimate.Id,
            customerName,
            eventId: booked.id,
            eventSummary: booked.summary,
          });
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

        await maybePostSuggestionNote(directive, 'qb-reconcile');
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
      skipped: summary.alreadyDirectived + summary.manuallyScheduled + summary.filtered,
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
