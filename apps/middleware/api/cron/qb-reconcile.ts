/**
 * QB Reconciliation Cron — Crawl-stage backstop for the scheduling
 * directive pipeline.
 *
 * Intuit doesn't guarantee delivery. If a QB webhook is missed (network
 * blip, ACL drift, or a flip that occurred before /api/qb-webhook was
 * live), the SchedulingDirective for that estimate never gets created
 * and Matt never sees it on /scheduling.
 *
 * This cron sweeps Estimates changed in the last `windowDays` via
 * `qb.listEstimatesUpdatedSince(sinceISO)` (LastUpdatedTime, not TxnDate:
 * a quote written weeks ago and accepted today must still be caught),
 * filters client-side to Accepted, skips already-invoiced work,
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
import { normalizeQbApproval, syncBookedEstimates, type BookingSyncSummary } from '@aac/scheduling';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { getPipedrive, getQuickBooks, getQuo } from '../../lib/clients.js';
import { bookedEventFor, listUpcomingEvents } from '../../lib/booked-events.js';
import { verifyCronAuth } from '../../lib/cron.js';
import { maybePostSuggestionNote } from '../../lib/suggestion-note.js';
import {
  getBookingSyncOutcome,
  getDirectiveIdByEstimate,
  countCondition,
  logHealthError,
  markEstimateHandled,
  setBookingSyncOutcome,
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
  /** Booking → QBO acceptance sync over the same upcoming events (null when the calendar was unavailable). */
  bookingSync: BookingSyncSummary | null;
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
    manuallyScheduled: 0,
    directivesCreated: 0,
    filtered: 0,
    errors: 0,
    bookingSync: null,
  };

  try {
    const qb = getQuickBooks();
    if (!(await qb.isConnected())) {
      log.warn('QuickBooks not connected; qb-reconcile skipped');
      res.status(200).json({ status: 'skipped', reason: 'qb_not_connected' });
      return;
    }

    const sinceISO = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const estimates = await qb.listEstimatesUpdatedSince(sinceISO);
    summary.scanned = estimates.length;

    const pd = getPipedrive();
    const quo = getQuo();

    // Walk #7 prereq 1: if the QB webhook was missed and Matt hand-scheduled
    // the job, the reverse index is empty but the work IS on the calendar.
    // Fetch upcoming events once per run and name-match per estimate. A
    // calendar failure degrades to the old behavior (guard disabled).
    let upcomingEvents: CalendarEvent[] | null = null;
    try {
      upcomingEvents = await listUpcomingEvents();
    } catch (err) {
      log.warn('Calendar unavailable — manual-schedule guard disabled this run', {
        error: (err as Error).message,
      });
    }

    for (const estimate of estimates) {
      if (estimate.TxnStatus !== 'Accepted') continue;
      summary.accepted++;

      // An edit to an old, already-invoiced quote bumps LastUpdatedTime;
      // the job is done, so there is nothing to schedule.
      if (estimate.LinkedTxn?.some((t) => t.TxnType === 'Invoice')) {
        summary.filtered++;
        continue;
      }

      try {
        const existing = await getDirectiveIdByEstimate(estimate.Id);
        if (existing) {
          summary.alreadyDirectived++;
          continue;
        }

        const customerName = estimate.CustomerRef?.name ?? '';
        const booked = upcomingEvents ? bookedEventFor(upcomingEvents, customerName) : undefined;
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

    // Reverse direction: a green job on the calendar marks its one open
    // quote Accepted (docs/plans/booking-acceptance-sync.md). Isolated so a
    // failure here never costs the directive pass above.
    if (upcomingEvents) {
      try {
        summary.bookingSync = await syncBookedEstimates(
          {
            qb,
            getEventOutcome: getBookingSyncOutcome,
            setEventOutcome: setBookingSyncOutcome,
            markEstimateHandled,
          },
          upcomingEvents,
        );
        summary.errors += summary.bookingSync.errors;
        if (summary.bookingSync.errors) await countCondition('booking-sync.error', { by: summary.bookingSync.errors });
      } catch (err) {
        summary.errors++;
        log.error('Booking sync failed', err as Error);
        await countCondition('booking-sync.error');
        await logHealthError('qb-reconcile', `booking-sync: ${(err as Error).message}`);
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
