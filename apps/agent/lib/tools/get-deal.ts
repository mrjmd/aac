/**
 * Tool: getDeal
 *
 * Fetches one deal and the entities it links to: person, QB estimate
 * (via qb_estimate_id), QB invoice (via qb_invoice_id), and any calendar
 * events tagged with `[deal:N]` for this deal.
 *
 * Returns `{ deal: null, ... }` when the deal doesn't exist — never throws
 * on not-found. The model can reason about a missing record; an exception
 * would derail the conversation.
 */

import { parseDealMarker } from '@aac/api-clients/pipedrive';
import {
  toDealSummary,
  toPersonSummary,
  toCalendarEventSummary,
  toEstimateSummary,
  toInvoiceSummary,
  type DealSummary,
  type PersonSummary,
  type CalendarEventSummary,
  type EstimateSummary,
  type InvoiceSummary,
  type ToolDeps,
} from './types.js';

export interface GetDealInput {
  dealId: number;
  /** How far back to search the calendar for matching `[deal:N]` events. Default 365. */
  eventLookbackDays?: number;
  /** Forward window for upcoming events tagged with this deal. Default 365. */
  eventLookForwardDays?: number;
}

export interface DealDetail {
  deal: DealSummary | null;
  person: PersonSummary | null;
  estimate: EstimateSummary | null;
  invoice: InvoiceSummary | null;
  events: CalendarEventSummary[];
}

export interface GetDealConfig {
  pdCompanyDomain: string;
}

export async function getDeal(
  deps: ToolDeps,
  config: GetDealConfig,
  input: GetDealInput,
): Promise<DealDetail> {
  const deal = await deps.pd.getDeal(input.dealId);
  if (!deal) {
    return { deal: null, person: null, estimate: null, invoice: null, events: [] };
  }

  const lookback = input.eventLookbackDays ?? 365;
  const lookforward = input.eventLookForwardDays ?? 365;
  const now = Date.now();
  const timeMin = new Date(now - lookback * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + lookforward * 24 * 60 * 60 * 1000).toISOString();

  const [person, estimate, invoice, events] = await Promise.all([
    deal.personId ? deps.pd.getPerson(deal.personId) : Promise.resolve(null),
    deal.qbEstimateId ? deps.qb.getEstimate(deal.qbEstimateId) : Promise.resolve(null),
    deal.qbInvoiceId ? deps.qb.getInvoice(deal.qbInvoiceId) : Promise.resolve(null),
    deps.cal.listEvents({ timeMin, timeMax, requireDescription: true }),
  ]);

  const taggedEvents: CalendarEventSummary[] = [];
  for (const event of events) {
    const markerId = parseDealMarker(event.description);
    if (markerId === deal.id) {
      taggedEvents.push(toCalendarEventSummary(event, markerId));
    }
  }

  return {
    deal: toDealSummary(deal),
    person: person ? toPersonSummary(person, config.pdCompanyDomain) : null,
    estimate: estimate ? toEstimateSummary(estimate) : null,
    invoice: invoice ? toInvoiceSummary(invoice) : null,
    events: taggedEvents,
  };
}
