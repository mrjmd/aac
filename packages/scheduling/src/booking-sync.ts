/**
 * Booking → QBO acceptance sync.
 *
 * Acceptance used to flow one way: QBO Accepted → scheduling directive.
 * When a customer approves by email, phone or text, or Matt books them
 * directly, the estimate stayed Pending, and `invoice-create` silently
 * skipped the job (`skipped_no_accepted_estimate`). This closes the loop:
 * a green job on the calendar whose customer has exactly one open quote
 * marks that quote Accepted, with the booking recorded as the evidence.
 *
 * Plan: docs/plans/booking-acceptance-sync.md. Called from the middleware
 * qb-reconcile cron (every 30 min) on the calendar events it already
 * fetches. Never guesses: zero or several open quotes leaves QBO alone
 * (triage D5 keeps flagging "booked but Pending" for Matt).
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBCustomer, QBEstimate, QuickBooksClient } from '@aac/api-clients/quickbooks';
import { streetKey } from '@aac/customers';
import { isBotDraft } from '@aac/quoting';
import { normalizePhone } from '@aac/shared-utils/phone';
import { createLogger } from '@aac/shared-utils/logger';
import { EVENT_CLASS_COLOR_IDS, STUB_TITLE_PREFIX } from './execute-stub.js';
import { summaryMatchesCustomer } from './name-match.js';

const log = createLogger('scheduling:booking-sync');

const DAY = 86_400_000;

/** A quote older than this at the booking date is not the one being booked. */
export const BOOKING_QUOTE_MAX_AGE_DAYS = 180;

/** An address or phone shared by this many customers is a hub (property manager, realtor): no evidence. */
const HUB_SIZE = 3;

export type BookingMatchVia = 'phone' | 'email' | 'name' | 'address';

export interface BookingCustomerMatch {
  customer: QBCustomer;
  via: BookingMatchVia[];
}

export type BookingDecision =
  | { kind: 'accept'; estimate: QBEstimate; customer: QBCustomer; via: BookingMatchVia[] }
  /** The customer already has an Accepted quote in the window: nothing to do. */
  | { kind: 'covered'; estimateId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; estimateIds: string[] };

/** Green (job) events, including job-class STUBs. Assessments, callbacks and HOLDs are not bookings of a quote. */
export function isBookedJob(e: Pick<CalendarEvent, 'colorId'>): boolean {
  return e.colorId === EVENT_CLASS_COLOR_IDS.job;
}

const PHONE_RE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function eventText(e: CalendarEvent): string {
  return [e.summary, e.location, e.description].filter(Boolean).join('\n');
}

function customerPhones(c: QBCustomer): string[] {
  return [c.PrimaryPhone, c.Mobile, c.AlternatePhone]
    .map((p) => (p?.FreeFormNumber ? normalizePhone(p.FreeFormNumber) : null))
    .filter((p): p is string => !!p);
}

function customerNames(c: QBCustomer): string[] {
  const full = [c.GivenName, c.FamilyName].filter(Boolean).join(' ');
  return [c.DisplayName, full, c.CompanyName ?? ''].filter((n) => n.trim().length > 0);
}

/**
 * Every customer the event plausibly belongs to, with how. Phone, email
 * and address are hard keys (ignored when shared by a hub); the name must
 * pass the strict `summaryMatchesCustomer` (≥2 tokens, all present).
 */
export function customersForBooking(event: CalendarEvent, customers: QBCustomer[]): BookingCustomerMatch[] {
  const text = eventText(event);
  const phones = new Set(
    [...text.matchAll(PHONE_RE)].map((m) => normalizePhone(m[0])).filter((p): p is string => !!p),
  );
  const emails = new Set([...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const addr = (event.location && streetKey(event.location)) || streetKey(event.description ?? '', true);
  const summary = event.summary.startsWith(STUB_TITLE_PREFIX)
    ? event.summary.slice(STUB_TITLE_PREFIX.length)
    : event.summary;

  const hits = new Map<QBCustomer, Set<BookingMatchVia>>();
  const add = (c: QBCustomer, via: BookingMatchVia) => {
    if (!hits.has(c)) hits.set(c, new Set());
    hits.get(c)!.add(via);
  };
  const byPhone: QBCustomer[] = [];
  const byAddress: QBCustomer[] = [];
  for (const c of customers) {
    if (customerPhones(c).some((p) => phones.has(p))) byPhone.push(c);
    const email = c.PrimaryEmailAddr?.Address?.toLowerCase();
    if (email && emails.has(email)) add(c, 'email');
    if (addr && c.BillAddr?.Line1 && streetKey(c.BillAddr.Line1) === addr) byAddress.push(c);
    if (customerNames(c).some((n) => summaryMatchesCustomer(summary, n))) add(c, 'name');
  }
  if (byPhone.length < HUB_SIZE) for (const c of byPhone) add(c, 'phone');
  if (byAddress.length < HUB_SIZE) for (const c of byAddress) add(c, 'address');
  return [...hits].map(([customer, via]) => ({ customer, via: [...via] }));
}

/**
 * Pick the quote this booking accepts. Candidates are the matched
 * customers' quotes dated within BOOKING_QUOTE_MAX_AGE_DAYS before the
 * event; unsent bot drafts never count (Matt hasn't reviewed them).
 */
export function decideBooking(
  event: CalendarEvent,
  matches: Array<BookingCustomerMatch & { estimates: QBEstimate[] }>,
): BookingDecision {
  const startMs = Date.parse(event.start);
  const inWindow = (e: QBEstimate) => {
    const t = e.TxnDate ? Date.parse(e.TxnDate) : NaN;
    return Number.isFinite(t) && t <= startMs + DAY && t >= startMs - BOOKING_QUOTE_MAX_AGE_DAYS * DAY;
  };
  const pending: Array<{ estimate: QBEstimate; match: BookingCustomerMatch }> = [];
  for (const m of matches) {
    for (const e of m.estimates.filter(inWindow)) {
      if (e.TxnStatus === 'Accepted') return { kind: 'covered', estimateId: e.Id };
      if (e.TxnStatus !== 'Pending') continue;
      if (isBotDraft(e) && e.EmailStatus !== 'EmailSent') continue;
      pending.push({ estimate: e, match: m });
    }
  }
  if (pending.length === 0) return { kind: 'none' };
  if (pending.length > 1) return { kind: 'ambiguous', estimateIds: pending.map((p) => p.estimate.Id) };
  const [{ estimate, match }] = pending;
  return { kind: 'accept', estimate, customer: match.customer, via: match.via };
}

export interface BookingSyncDeps {
  qb: Pick<QuickBooksClient, 'listAllCustomers' | 'getEstimatesByCustomer' | 'updateEstimate'>;
  /** Outcome recorded for this event by an earlier run, if it is still live. */
  getEventOutcome(eventId: string): Promise<string | null>;
  /** Record an outcome. Final outcomes stick; others expire so the event is looked at again. */
  setEventOutcome(eventId: string, outcome: string, final: boolean): Promise<void>;
  /** The qb-webhook / qb-reconcile "already handled" marker, so our own flip makes no directive. */
  markEstimateHandled(estimateId: string, marker: string): Promise<void>;
}

export interface BookingSyncSummary {
  jobs: number;
  accepted: number;
  covered: number;
  none: number;
  ambiguous: number;
  errors: number;
}

function evidenceNote(event: CalendarEvent, via: BookingMatchVia[]): string {
  return `Accepted by booking sync: "${event.summary}" on ${event.start.slice(0, 10)} (calendar event ${event.id}, matched by ${via.join(' + ')}).`;
}

/**
 * Run the sync over calendar events. Idempotent: an event with a final
 * outcome is skipped, and the customer list loads only when at least one
 * job still needs a look.
 */
export async function syncBookedEstimates(
  deps: BookingSyncDeps,
  events: CalendarEvent[],
): Promise<BookingSyncSummary> {
  const summary: BookingSyncSummary = { jobs: 0, accepted: 0, covered: 0, none: 0, ambiguous: 0, errors: 0 };
  const todo: CalendarEvent[] = [];
  for (const e of events.filter(isBookedJob)) {
    summary.jobs++;
    if (!(await deps.getEventOutcome(e.id))) todo.push(e);
  }
  if (todo.length === 0) return summary;

  const customers = await deps.qb.listAllCustomers();
  const estimatesByCustomer = new Map<string, QBEstimate[]>();
  const estimatesFor = async (id: string) => {
    if (!estimatesByCustomer.has(id)) estimatesByCustomer.set(id, await deps.qb.getEstimatesByCustomer(id));
    return estimatesByCustomer.get(id)!;
  };

  for (const event of todo) {
    try {
      const matches = await Promise.all(
        customersForBooking(event, customers)
          .filter((m) => m.customer.Id)
          .map(async (m) => ({ ...m, estimates: await estimatesFor(m.customer.Id!) })),
      );
      const d = decideBooking(event, matches);
      if (d.kind === 'accept') {
        await deps.markEstimateHandled(d.estimate.Id, `booking-sync:${event.id}`);
        const note = evidenceNote(event, d.via);
        await deps.qb.updateEstimate(d.estimate.Id, {
          txnStatus: 'Accepted',
          privateNote: d.estimate.PrivateNote ? `${note}\n${d.estimate.PrivateNote}` : note,
        });
        d.estimate.TxnStatus = 'Accepted';
        await deps.setEventOutcome(event.id, `accepted:${d.estimate.Id}`, true);
        summary.accepted++;
        log.info('Booked job marked its quote Accepted', {
          eventId: event.id,
          eventSummary: event.summary,
          estimateId: d.estimate.Id,
          docNumber: d.estimate.DocNumber,
          customer: d.customer.DisplayName,
          via: d.via,
        });
      } else if (d.kind === 'covered') {
        await deps.setEventOutcome(event.id, `covered:${d.estimateId}`, true);
        summary.covered++;
      } else {
        await deps.setEventOutcome(event.id, d.kind, false);
        summary[d.kind]++;
        if (d.kind === 'ambiguous') {
          log.info('Booked job has several open quotes — left for Matt', {
            eventId: event.id,
            eventSummary: event.summary,
            estimateIds: d.estimateIds,
          });
        }
      }
    } catch (err) {
      summary.errors++;
      log.error('Booking sync failed for event', err as Error, { eventId: event.id });
    }
  }
  return summary;
}
