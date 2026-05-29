/**
 * Tool: findJobsMissingInvoices
 *
 * The "did I forget to invoice anyone?" tool. Walks green calendar events
 * (color 10, job) in the given range and reports any that lack a QB invoice.
 *
 * Three failure modes the model can act on:
 *   - `no_deal_link`           — event has no `[deal:N]` marker; we can't
 *                                trace it to a deal at all. Backfill needed.
 *   - `deal_has_no_invoice`    — deal exists, qbInvoiceId is empty. Cron A
 *                                hasn't created the invoice (or job hasn't
 *                                completed yet).
 *   - `invoice_not_found_in_qb`— deal references a qb_invoice_id but the QB
 *                                fetch returned nothing. Data drift.
 */

import { parseDealMarker } from '@aac/api-clients/pipedrive';
import {
  toCalendarEventSummary,
  toPersonSummary,
  toDealSummary,
  type CalendarEventSummary,
  type PersonSummary,
  type DealSummary,
  type ToolDeps,
} from './types.js';

export interface FindJobsMissingInvoicesInput {
  rangeStart: string;
  rangeEnd: string;
}

export type MissingInvoiceReason =
  | 'no_deal_link'
  | 'deal_has_no_invoice'
  | 'invoice_not_found_in_qb';

export interface MissingInvoiceItem {
  event: CalendarEventSummary;
  matchedPerson: PersonSummary | null;
  matchedDeal: DealSummary | null;
  reason: MissingInvoiceReason;
}

export interface FindJobsMissingInvoicesConfig {
  pdCompanyDomain: string;
}

const JOB_COLOR_ID = '10';

export async function findJobsMissingInvoices(
  deps: ToolDeps,
  config: FindJobsMissingInvoicesConfig,
  input: FindJobsMissingInvoicesInput,
): Promise<MissingInvoiceItem[]> {
  if (!input.rangeStart || !input.rangeEnd) {
    throw new Error('findJobsMissingInvoices requires rangeStart and rangeEnd');
  }

  const events = await deps.cal.listEvents({
    timeMin: input.rangeStart,
    timeMax: input.rangeEnd,
    colorIds: [JOB_COLOR_ID],
  });

  const results: MissingInvoiceItem[] = [];
  for (const event of events) {
    const dealId = parseDealMarker(event.description);

    if (dealId === null) {
      results.push({
        event: toCalendarEventSummary(event, null),
        matchedPerson: null,
        matchedDeal: null,
        reason: 'no_deal_link',
      });
      continue;
    }

    const deal = await deps.pd.getDeal(dealId);
    if (!deal) {
      results.push({
        event: toCalendarEventSummary(event, dealId),
        matchedPerson: null,
        matchedDeal: null,
        reason: 'no_deal_link',
      });
      continue;
    }

    const person = deal.personId ? await deps.pd.getPerson(deal.personId) : null;
    const personSummary = person ? toPersonSummary(person, config.pdCompanyDomain) : null;
    const dealSummary = toDealSummary(deal);

    if (!deal.qbInvoiceId) {
      results.push({
        event: toCalendarEventSummary(event, dealId),
        matchedPerson: personSummary,
        matchedDeal: dealSummary,
        reason: 'deal_has_no_invoice',
      });
      continue;
    }

    const invoice = await deps.qb.getInvoice(deal.qbInvoiceId);
    if (!invoice) {
      results.push({
        event: toCalendarEventSummary(event, dealId),
        matchedPerson: personSummary,
        matchedDeal: dealSummary,
        reason: 'invoice_not_found_in_qb',
      });
    }
  }

  return results;
}
