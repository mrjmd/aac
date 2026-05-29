/**
 * Shared types for the apps/agent read-tool surface.
 *
 * Tools return *summary* shapes — compact, LLM-friendly projections of the
 * raw client types. The model chains tool calls to drill in (e.g. listDeals
 * → getDeal) rather than every response carrying the full client payload.
 *
 * Mapping helpers (`toPersonSummary`, `toDealSummary`, etc.) live here so
 * each tool implementation can focus on the join/filter logic and not the
 * field projection.
 */

import type {
  PipedrivePerson,
  PipedriveDeal,
  DealStage,
  LostReason,
} from '@aac/api-clients/pipedrive';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import type { QuoMessage, QuoCall } from '@aac/api-clients/quo';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuoClient } from '@aac/api-clients/quo';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';

// ── Dependency bundle ───────────────────────────────────────────────

export interface ToolDeps {
  pd: PipedriveClient;
  qb: QuickBooksClient;
  quo: QuoClient;
  cal: GoogleCalendarClient;
}

// ── Summary shapes ──────────────────────────────────────────────────

export interface PersonSummary {
  id: number;
  name: string;
  phones: string[];
  emails: string[];
  organizationId: number | null;
  pdUrl: string;
}

export interface DealSummary {
  id: number;
  title: string;
  stage: DealStage | null;
  status: 'open' | 'won' | 'lost' | 'deleted';
  personId: number | null;
  value: number | null;
  qbEstimateId: string | null;
  qbInvoiceId: string | null;
  lostReason: LostReason | null;
  addTime: string;
  updateTime: string;
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string | null;
  colorId: string | null;
  /** `[deal:N]` marker parsed from the description, if present. */
  dealId: number | null;
  htmlLink: string;
}

export interface EstimateSummary {
  id: string;
  docNumber: string | null;
  status: QBEstimate['TxnStatus'] | null;
  txnDate: string | null;
  totalAmount: number | null;
  customerName: string | null;
  customerId: string | null;
  /** IDs of QB invoices linked to this estimate via LinkedTxn. */
  linkedInvoiceIds: string[];
}

export interface InvoiceSummary {
  id: string;
  docNumber: string | null;
  txnDate: string | null;
  totalAmount: number | null;
  balance: number | null;
  paid: boolean;
  customerName: string | null;
  customerId: string | null;
  /** IDs of QB estimates this invoice was created from, via LinkedTxn. */
  linkedEstimateIds: string[];
}

export interface QuoMessageSummary {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string[];
  text: string;
  createdAt: string;
}

export interface QuoCallSummary {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  status: QuoCall['status'];
  durationSeconds: number | null;
  createdAt: string;
}

// ── Mappers (raw client type → summary) ──────────────────────────────

export function toPersonSummary(
  person: PipedrivePerson,
  companyDomain: string,
): PersonSummary {
  return {
    id: person.id,
    name: person.name,
    phones: (person.phone ?? []).map((p) => p.value).filter(Boolean),
    emails: (person.email ?? []).map((e) => e.value).filter(Boolean),
    organizationId: person.org_id ?? null,
    pdUrl: `https://${companyDomain}.pipedrive.com/person/${person.id}`,
  };
}

export function toDealSummary(deal: PipedriveDeal): DealSummary {
  return {
    id: deal.id,
    title: deal.title,
    stage: deal.stage,
    status: deal.status,
    personId: deal.personId,
    value: deal.value,
    qbEstimateId: deal.qbEstimateId,
    qbInvoiceId: deal.qbInvoiceId,
    lostReason: deal.lostReason,
    addTime: deal.addTime,
    updateTime: deal.updateTime,
  };
}

export function toCalendarEventSummary(
  event: CalendarEvent,
  dealId: number | null,
): CalendarEventSummary {
  return {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location ?? null,
    colorId: event.colorId ?? null,
    dealId,
    htmlLink: event.htmlLink,
  };
}

export function toEstimateSummary(estimate: QBEstimate): EstimateSummary {
  const linkedInvoiceIds = (estimate.LinkedTxn ?? [])
    .filter((t) => t.TxnType === 'Invoice')
    .map((t) => t.TxnId);
  return {
    id: estimate.Id,
    docNumber: estimate.DocNumber ?? null,
    status: estimate.TxnStatus ?? null,
    txnDate: estimate.TxnDate ?? null,
    totalAmount: estimate.TotalAmt ?? null,
    customerName: estimate.CustomerRef?.name ?? null,
    customerId: estimate.CustomerRef?.value ?? null,
    linkedInvoiceIds,
  };
}

export function toInvoiceSummary(invoice: QBInvoice): InvoiceSummary {
  const linkedEstimateIds = (invoice.LinkedTxn ?? [])
    .filter((t) => t.TxnType === 'Estimate')
    .map((t) => t.TxnId);
  return {
    id: invoice.Id,
    docNumber: invoice.DocNumber ?? null,
    txnDate: invoice.TxnDate ?? null,
    totalAmount: invoice.TotalAmt ?? null,
    balance: invoice.Balance ?? null,
    paid: (invoice.Balance ?? 1) === 0,
    customerName: invoice.CustomerRef?.name ?? null,
    customerId: invoice.CustomerRef?.value ?? null,
    linkedEstimateIds,
  };
}

export function toQuoMessageSummary(message: QuoMessage): QuoMessageSummary {
  return {
    id: message.id,
    direction: message.direction,
    from: message.from,
    to: message.to,
    text: message.text,
    createdAt: message.createdAt,
  };
}

export function toQuoCallSummary(call: QuoCall): QuoCallSummary {
  return {
    id: call.id,
    direction: call.direction,
    from: call.from,
    to: call.to,
    status: call.status,
    durationSeconds: call.duration ?? null,
    createdAt: call.createdAt,
  };
}
