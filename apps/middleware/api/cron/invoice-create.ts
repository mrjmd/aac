/**
 * Invoice Create Cron — Auto-create a QuickBooks invoice for each
 * green calendar job scheduled today, from the customer's most-recent
 * Accepted estimate. Does NOT send the invoice — invoice-send handles that.
 *
 * Schedule (when enabled in vercel.json): daily ~7am ET.
 * Supports dry run: GET /api/cron/invoice-create?dry=true
 * Date override:    GET /api/cron/invoice-create?date=2026-05-18
 *
 * Filtering (identical to job-followups for consistency):
 * - Technician as attendee (env TECHNICIAN_EMAILS, single source of truth)
 * - Green color (10) only — real jobs, not callbacks/assessments
 * - Has location
 * - ≥120 min duration
 * - Excludes callback/lunch/dinner/meeting/estimate-only/consultation-only
 *
 * Edge cases (see docs/middleware-auto-invoicing.md for full notes):
 * - Multi-accepted-estimate ambiguity: SKIP + send SMS alert to alertPhone.
 * - Invoice already exists for this customer in last 24h: SKIP (manual wins).
 * - Cash/check pay-then-Mike-forgets-to-mark: NOT solved here. Operational.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getCalendar, getPipedrive, getQuo, getQuickBooks } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import {
  verifyCronAuth,
  GREEN_COLOR_IDS,
  NON_JOB_KEYWORDS,
  MIN_JOB_DURATION_MINUTES,
  getDayRangeEastern,
  isoDateDaysAgo,
} from '../../lib/cron.js';
import { markCronAction, trackCronRun, logHealthError } from '../../lib/redis.js';
import { matchEventToPerson, matchPersonToQBCustomer } from '../../lib/job-customer-match.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('cron:invoice-create');

interface CreateResult {
  eventId: string;
  summary: string;
  jobDate: string;
  location: string;
  personName: string | null;
  qbCustomerId: string | null;
  estimateId: string | null;
  invoiceId: string | null;
  amount: number | null;
  status:
    | 'created'
    | 'skipped_dedup'
    | 'skipped_no_person'
    | 'skipped_no_qb_customer'
    | 'skipped_no_accepted_estimate'
    | 'skipped_multi_accepted_estimate'
    | 'skipped_existing_invoice'
    | 'error';
  reason?: string;
  error?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCronAuth(req, res)) return;

  const isDryRun = req.query.dry === 'true';
  const dateOverride = req.query.date as string | undefined;
  const results: CreateResult[] = [];
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const env = getEnv();
    const calendar = getCalendar();
    const pipedrive = getPipedrive();
    const qb = getQuickBooks();
    const quo = getQuo();

    const { timeMin, timeMax, dateLabel } = getDayRangeEastern(0, dateOverride);
    log.info('Invoice-create cron started', { isDryRun, dateLabel });

    const events = await calendar.listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.google.technicianEmails,
      colorIds: GREEN_COLOR_IDS,
      requireLocation: true,
      excludeKeywords: NON_JOB_KEYWORDS,
      minDurationMinutes: MIN_JOB_DURATION_MINUTES,
    });

    log.info('Today\'s jobs found', { count: events.length });

    for (const event of events) {
      const result = await processEvent(event, pipedrive, qb, quo, env.notifications.alertPhoneNumber, isDryRun);
      results.push(result);
      if (result.status === 'created') created++;
      else if (result.status.startsWith('skipped')) skipped++;
      else errors++;
    }

    if (!isDryRun) {
      // trackCronRun expects { sent, skipped, errors } — map "created" → "sent"
      await trackCronRun('invoice-create', { sent: created, skipped, errors });
    }

    log.info('Invoice-create cron complete', { isDryRun, created, skipped, errors });

    return res.status(200).json({
      dryRun: isDryRun,
      jobDate: dateLabel,
      summary: { created, skipped, errors, totalEvents: events.length },
      results,
    });
  } catch (error) {
    log.error('Invoice-create cron failed', error as Error);
    await logHealthError('cron:invoice-create', (error as Error).message);
    return res.status(500).json({
      dryRun: isDryRun,
      error: (error as Error).message,
      summary: { created, skipped, errors },
      results,
    });
  }
}

async function processEvent(
  event: CalendarEvent,
  pipedrive: ReturnType<typeof getPipedrive>,
  qb: ReturnType<typeof getQuickBooks>,
  quo: ReturnType<typeof getQuo>,
  alertPhone: string,
  isDryRun: boolean
): Promise<CreateResult> {
  const base = {
    eventId: event.id,
    summary: event.summary,
    jobDate: event.start.split('T')[0],
    location: event.location || '',
  };

  try {
    // Dedupe by event id — one invoice per scheduled job
    if (!isDryRun) {
      const isNew = await markCronAction('invoice-create', event.id);
      if (!isNew) {
        return { ...base, personName: null, qbCustomerId: null, estimateId: null, invoiceId: null, amount: null, status: 'skipped_dedup' };
      }
    }

    const person = await matchEventToPerson(event, pipedrive);
    if (!person) {
      log.warn('No Pipedrive person', { eventId: event.id, summary: event.summary });
      return { ...base, personName: null, qbCustomerId: null, estimateId: null, invoiceId: null, amount: null, status: 'skipped_no_person' };
    }

    const customer = await matchPersonToQBCustomer(person, qb);
    if (!customer || !customer.Id) {
      log.warn('No QB customer match', { eventId: event.id, personId: person.id, personName: person.name });
      return { ...base, personName: person.name, qbCustomerId: null, estimateId: null, invoiceId: null, amount: null, status: 'skipped_no_qb_customer' };
    }

    // Don't auto-create if Matt/Mike already created one manually in the last 24h
    const recentInvoices = await qb.getInvoicesByCustomer(customer.Id, isoDateDaysAgo(1));
    if (recentInvoices.length > 0) {
      return {
        ...base,
        personName: person.name,
        qbCustomerId: customer.Id,
        estimateId: null,
        invoiceId: recentInvoices[0].Id,
        amount: null,
        status: 'skipped_existing_invoice',
        reason: 'Invoice already exists for this customer in last 24h',
      };
    }

    const accepted = await qb.getEstimatesByCustomer(customer.Id, 'Accepted');
    if (accepted.length === 0) {
      return { ...base, personName: person.name, qbCustomerId: customer.Id, estimateId: null, invoiceId: null, amount: null, status: 'skipped_no_accepted_estimate' };
    }

    // Multi-estimate ambiguity → don't guess. Notify Matt; he handles manually.
    if (accepted.length > 1) {
      const lines = accepted
        .map((e) => `  • Est ${e.DocNumber ?? e.Id}: $${e.TotalAmt ?? '?'}`)
        .join('\n');
      const message =
        `AAC auto-invoice SKIPPED — multiple accepted estimates for ${customer.DisplayName}.\n` +
        `Today's job: ${event.summary} @ ${event.location || 'n/a'}\n` +
        `${lines}\nCreate the right invoice manually in QB.`;
      if (!isDryRun) {
        try {
          await quo.sendMessage(alertPhone, message);
        } catch (alertErr) {
          log.error('Failed to send multi-estimate alert SMS', alertErr as Error, { eventId: event.id });
        }
      }
      return {
        ...base,
        personName: person.name,
        qbCustomerId: customer.Id,
        estimateId: null,
        invoiceId: null,
        amount: null,
        status: 'skipped_multi_accepted_estimate',
        reason: `${accepted.length} accepted estimates`,
      };
    }

    const estimate = accepted[0];

    if (isDryRun) {
      return {
        ...base,
        personName: person.name,
        qbCustomerId: customer.Id,
        estimateId: estimate.Id,
        invoiceId: null,
        amount: estimate.TotalAmt ?? null,
        status: 'created',
        reason: 'dry-run',
      };
    }

    const invoice = await qb.createInvoiceFromEstimate(estimate.Id);

    log.info('Invoice created', {
      eventId: event.id,
      personName: person.name,
      qbCustomerId: customer.Id,
      estimateId: estimate.Id,
      invoiceId: invoice.Id,
      amount: invoice.TotalAmt,
    });

    return {
      ...base,
      personName: person.name,
      qbCustomerId: customer.Id,
      estimateId: estimate.Id,
      invoiceId: invoice.Id,
      amount: invoice.TotalAmt ?? null,
      status: 'created',
    };
  } catch (error) {
    log.error('Failed to process event for invoice creation', {
      eventId: event.id,
      summary: event.summary,
      error: (error as Error).message,
    });
    if (!isDryRun) {
      await logHealthError('cron:invoice-create', `Failed for ${event.summary}: ${(error as Error).message}`);
    }
    return {
      ...base,
      personName: null,
      qbCustomerId: null,
      estimateId: null,
      invoiceId: null,
      amount: null,
      status: 'error',
      error: (error as Error).message,
    };
  }
}
