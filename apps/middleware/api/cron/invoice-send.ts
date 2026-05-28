/**
 * Invoice Send Cron — Two days after a green calendar job, email the
 * customer their QB invoice (default QB template) if it's still unpaid
 * AND unsent. Skip if Mike/Matt already paid-marked or sent it manually.
 *
 * Schedule (when enabled in vercel.json): daily ~7:05am ET (after
 * invoice-create). Matt waits ~1 week of clean invoice-create runs
 * before enabling this one.
 *
 * Supports dry run: GET /api/cron/invoice-send?dry=true
 * Override delay:   GET /api/cron/invoice-send?delay=3
 * Date override:    GET /api/cron/invoice-send?date=2026-05-18
 *
 * Filtering identical to invoice-create / job-followups.
 *
 * Edge case NOT solved here: cash/check payment + Mike forgets to mark
 * paid in QB. We email the customer asking for already-paid money.
 * Mitigated operationally (Mike must mark-paid immediately), NOT in code.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getCalendar, getPipedrive, getQuickBooks } from '../../lib/clients.js';
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

const log = createLogger('cron:invoice-send');

const DEFAULT_DELAY_DAYS = 2;

/** Look back enough to find the invoice created on or near the job day */
const INVOICE_LOOKBACK_DAYS = 5;

interface SendResult {
  eventId: string;
  summary: string;
  jobDate: string;
  location: string;
  personName: string | null;
  qbCustomerId: string | null;
  invoiceId: string | null;
  status:
    | 'sent'
    | 'skipped_dedup'
    | 'skipped_no_person'
    | 'skipped_no_qb_customer'
    | 'skipped_no_invoice'
    | 'skipped_paid'
    | 'skipped_already_sent'
    | 'error';
  reason?: string;
  error?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCronAuth(req, res)) return;

  const isDryRun = req.query.dry === 'true';
  const delayDays = parseInt(req.query.delay as string, 10) || DEFAULT_DELAY_DAYS;
  const dateOverride = req.query.date as string | undefined;
  const results: SendResult[] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const env = getEnv();
    const calendar = getCalendar();
    const pipedrive = getPipedrive();
    const qb = getQuickBooks();

    const { timeMin, timeMax, dateLabel } = getDayRangeEastern(-delayDays, dateOverride);
    log.info('Invoice-send cron started', { isDryRun, delayDays, dateLabel });

    const events = await calendar.listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.google.technicianEmails,
      colorIds: GREEN_COLOR_IDS,
      requireLocation: true,
      excludeKeywords: NON_JOB_KEYWORDS,
      minDurationMinutes: MIN_JOB_DURATION_MINUTES,
    });

    log.info('Lookback jobs found', { count: events.length });

    for (const event of events) {
      const result = await processEvent(event, pipedrive, qb, isDryRun);
      results.push(result);
      if (result.status === 'sent') sent++;
      else if (result.status.startsWith('skipped')) skipped++;
      else errors++;
    }

    if (!isDryRun) {
      await trackCronRun('invoice-send', { sent, skipped, errors });
    }

    log.info('Invoice-send cron complete', { isDryRun, sent, skipped, errors });

    return res.status(200).json({
      dryRun: isDryRun,
      lookbackDate: dateLabel,
      delayDays,
      summary: { sent, skipped, errors, totalEvents: events.length },
      results,
    });
  } catch (error) {
    log.error('Invoice-send cron failed', error as Error);
    await logHealthError('cron:invoice-send', (error as Error).message);
    return res.status(500).json({
      dryRun: isDryRun,
      error: (error as Error).message,
      summary: { sent, skipped, errors },
      results,
    });
  }
}

async function processEvent(
  event: CalendarEvent,
  pipedrive: ReturnType<typeof getPipedrive>,
  qb: ReturnType<typeof getQuickBooks>,
  isDryRun: boolean
): Promise<SendResult> {
  const base = {
    eventId: event.id,
    summary: event.summary,
    jobDate: event.start.split('T')[0],
    location: event.location || '',
  };

  try {
    if (!isDryRun) {
      const isNew = await markCronAction('invoice-send', event.id);
      if (!isNew) {
        return { ...base, personName: null, qbCustomerId: null, invoiceId: null, status: 'skipped_dedup' };
      }
    }

    const person = await matchEventToPerson(event, pipedrive);
    if (!person) {
      return { ...base, personName: null, qbCustomerId: null, invoiceId: null, status: 'skipped_no_person' };
    }

    const customer = await matchPersonToQBCustomer(person, qb);
    if (!customer || !customer.Id) {
      return { ...base, personName: person.name, qbCustomerId: null, invoiceId: null, status: 'skipped_no_qb_customer' };
    }

    const invoices = await qb.getInvoicesByCustomer(customer.Id, isoDateDaysAgo(INVOICE_LOOKBACK_DAYS));
    if (invoices.length === 0) {
      return { ...base, personName: person.name, qbCustomerId: customer.Id, invoiceId: null, status: 'skipped_no_invoice' };
    }

    const invoice = invoices[0];

    if ((invoice.Balance ?? 0) === 0) {
      return { ...base, personName: person.name, qbCustomerId: customer.Id, invoiceId: invoice.Id, status: 'skipped_paid' };
    }

    if (invoice.EmailStatus === 'EmailSent') {
      return { ...base, personName: person.name, qbCustomerId: customer.Id, invoiceId: invoice.Id, status: 'skipped_already_sent' };
    }

    if (isDryRun) {
      return { ...base, personName: person.name, qbCustomerId: customer.Id, invoiceId: invoice.Id, status: 'sent', reason: 'dry-run' };
    }

    await qb.sendInvoice(invoice.Id);

    log.info('Invoice sent', {
      eventId: event.id,
      personName: person.name,
      qbCustomerId: customer.Id,
      invoiceId: invoice.Id,
    });

    return { ...base, personName: person.name, qbCustomerId: customer.Id, invoiceId: invoice.Id, status: 'sent' };
  } catch (error) {
    log.error('Failed to process event for invoice send', {
      eventId: event.id,
      summary: event.summary,
      error: (error as Error).message,
    });
    if (!isDryRun) {
      await logHealthError('cron:invoice-send', `Failed for ${event.summary}: ${(error as Error).message}`);
    }
    return {
      ...base,
      personName: null,
      qbCustomerId: null,
      invoiceId: null,
      status: 'error',
      error: (error as Error).message,
    };
  }
}
