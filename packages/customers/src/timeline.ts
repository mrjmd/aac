import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GmailClient, GmailMessage } from '@aac/api-clients/gmail';
import type { QBCustomer, QBEstimate, QBInvoice, QBPayment, QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoClient, QuoMessage } from '@aac/api-clients/quo';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { eventMatchesName, nameTokens, streetKey } from './match.js';

const DAY = 86_400_000;

/** Who the customer is, as QBO knows them, plus the handles we join on. */
export interface CustomerProfile {
  id: string;
  name: string;
  company?: string;
  /** E.164, de-duplicated. */
  phones: string[];
  /** Lowercased. QBO allows several comma-separated addresses in one field. */
  emails: string[];
  address?: string;
  /** `{num}|{street}|{unit}` of the billing address (see streetKey). */
  streetKey: string | null;
  active: boolean;
}

export type TimelineKind = 'quote' | 'invoice' | 'payment' | 'text' | 'call' | 'email' | 'visit';

export interface TimelineEntry {
  id: string;
  /** ISO timestamp; date-only sources (QBO TxnDate) sit at noon UTC. */
  at: string;
  kind: TimelineKind;
  direction?: 'in' | 'out';
  title: string;
  detail?: string;
  amount?: number;
  /** quote: TxnStatus; invoice: paid/open/overdue; call: completed/missed/... */
  status?: string;
  href?: string;
  /** Calendar visits only. */
  visit?: { colorId?: string; end: string; matchedBy: 'address' | 'phone' | 'name' };
}

export interface SourceStatus {
  source: 'quickbooks' | 'quo' | 'gmail' | 'calendar';
  ok: boolean;
  count: number;
  error?: string;
}

export interface CustomerTimeline {
  profile: CustomerProfile;
  /** Newest first. */
  entries: TimelineEntry[];
  totals: {
    /** Quotes not rejected/closed-without-invoice, i.e. Pending + Accepted. */
    openQuotes: number;
    acceptedQuotes: number;
    invoiced: number;
    paid: number;
    openBalance: number;
    overdueBalance: number;
  };
  lastContact?: TimelineEntry;
  nextVisit?: TimelineEntry;
  sources: SourceStatus[];
}

export interface TimelineInputs {
  customer: QBCustomer & { Id: string };
  estimates: QBEstimate[];
  invoices: QBInvoice[];
  payments: QBPayment[];
  messages: QuoMessage[];
  calls: QuoCall[];
  emails: GmailMessage[];
  events: CalendarEvent[];
  /** YYYY-MM-DD today (America/New_York), for overdue and upcoming. */
  today: string;
  now: Date;
  sources?: SourceStatus[];
}

// ── profile ──────────────────────────────────────────────────────────

export function customerProfile(c: QBCustomer & { Id: string }): CustomerProfile {
  const phones = [c.PrimaryPhone, c.Mobile, c.AlternatePhone]
    .map((p) => quickNormalizePhone(p?.FreeFormNumber))
    .filter((p): p is string => !!p);
  const emails = (c.PrimaryEmailAddr?.Address ?? '')
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
  const a = c.BillAddr;
  const address = [a?.Line1, a?.City, a?.CountrySubDivisionCode].filter(Boolean).join(', ') || undefined;
  return {
    id: c.Id,
    name: c.DisplayName,
    company: c.CompanyName && c.CompanyName !== c.DisplayName ? c.CompanyName : undefined,
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    address,
    streetKey: a?.Line1 ? streetKey(a.Line1) : null,
    active: c.Active !== false,
  };
}

// ── calendar matching ────────────────────────────────────────────────

/** Same house + street; units must agree only when both sides have one. */
export function sameStreet(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [an, as, au] = a.split('|');
  const [bn, bs, bu] = b.split('|');
  return an === bn && as === bs && (!au || !bu || au === bu);
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

/**
 * Why this calendar event belongs to the customer, or null. Address and
 * phone are hard joins. A name match alone is rejected when the event is
 * at a different address, so a shared surname doesn't pull in a
 * stranger's job.
 */
export function eventMatch(ev: CalendarEvent, profile: CustomerProfile): 'address' | 'phone' | 'name' | null {
  const evKey = streetKey(ev.location ?? '') ?? streetKey(ev.summary, true);
  if (sameStreet(evKey, profile.streetKey)) return 'address';
  const evPhones = (ev.description ?? '').match(PHONE_RE) ?? [];
  if (evPhones.some((p) => profile.phones.includes(quickNormalizePhone(p) ?? ''))) return 'phone';
  if (evKey && profile.streetKey) return null;
  const tokens = nameTokens(profile.name);
  return eventMatchesName(ev, tokens) ? 'name' : null;
}

// ── timeline ─────────────────────────────────────────────────────────

const noon = (d: string | undefined, fallback?: string) => (d ? `${d}T12:00:00.000Z` : (fallback ?? ''));
const money = (n: number | undefined) => n ?? 0;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function quoteDetail(e: QBEstimate): string | undefined {
  const lines = e.Line.filter((l) => l.DetailType === 'SalesItemLineDetail' && l.Amount > 0);
  const names = lines.map((l) => l.SalesItemLineDetail?.ItemRef?.name ?? clip(l.Description ?? '', 40)).filter(Boolean);
  return names.length ? names.join(' · ') : undefined;
}

export function buildCustomerTimeline(input: TimelineInputs): CustomerTimeline {
  const profile = customerProfile(input.customer);
  const entries: TimelineEntry[] = [];

  for (const e of input.estimates) {
    entries.push({
      id: `quote:${e.Id}`,
      at: noon(e.TxnDate, e.MetaData?.CreateTime),
      kind: 'quote',
      title: `Quote #${e.DocNumber ?? e.Id}`,
      detail: quoteDetail(e),
      amount: money(e.TotalAmt),
      status: e.TxnStatus,
    });
  }

  let invoiced = 0;
  let openBalance = 0;
  let overdueBalance = 0;
  for (const inv of input.invoices) {
    const balance = money(inv.Balance);
    const overdue = balance > 0 && !!inv.DueDate && inv.DueDate < input.today;
    invoiced += money(inv.TotalAmt);
    openBalance += balance;
    if (overdue) overdueBalance += balance;
    entries.push({
      id: `invoice:${inv.Id}`,
      at: noon(inv.TxnDate, inv.MetaData?.CreateTime),
      kind: 'invoice',
      title: `Invoice #${inv.DocNumber ?? inv.Id}`,
      detail: balance > 0 ? `\$${balance.toLocaleString('en-US')} open${inv.DueDate ? `, due ${inv.DueDate}` : ''}` : undefined,
      amount: money(inv.TotalAmt),
      status: balance <= 0 ? 'paid' : overdue ? 'overdue' : 'open',
    });
  }

  let paid = 0;
  for (const p of input.payments) {
    paid += p.TotalAmt;
    entries.push({
      id: `payment:${p.Id}`,
      at: noon(p.TxnDate, p.MetaData?.CreateTime),
      kind: 'payment',
      direction: 'in',
      title: 'Payment received',
      detail: p.PaymentRefNum ? `Ref ${p.PaymentRefNum}` : undefined,
      amount: p.TotalAmt,
    });
  }

  for (const m of input.messages) {
    const media = m.media?.length ?? 0;
    entries.push({
      id: `text:${m.id}`,
      at: m.createdAt,
      kind: 'text',
      direction: m.direction === 'incoming' ? 'in' : 'out',
      title: m.direction === 'incoming' ? 'Text from customer' : 'Text to customer',
      detail: [clip(m.text ?? '', 400), media ? `${media} photo${media === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || undefined,
    });
  }

  for (const c of input.calls) {
    const mins = c.duration ? Math.max(1, Math.round(c.duration / 60)) : 0;
    const answered = c.status === 'completed' && mins > 0;
    entries.push({
      id: `call:${c.id}`,
      at: c.createdAt,
      kind: 'call',
      direction: c.direction === 'incoming' ? 'in' : 'out',
      title: answered
        ? `${c.direction === 'incoming' ? 'Call from customer' : 'Call to customer'} (${mins} min)`
        : c.direction === 'incoming'
          ? 'Missed call from customer'
          : 'Unanswered call to customer',
      detail: c.voicemail ? 'Left a voicemail' : undefined,
      status: c.status,
    });
  }

  const ours = (addr: string) => !profile.emails.includes(addr);
  for (const m of input.emails) {
    const outgoing = ours(m.fromAddress);
    entries.push({
      id: `email:${m.id}`,
      at: m.at,
      kind: 'email',
      direction: outgoing ? 'out' : 'in',
      title: m.subject || '(no subject)',
      detail: clip(m.snippet, 240) || undefined,
      href: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
    });
  }

  for (const ev of input.events) {
    const matchedBy = eventMatch(ev, profile);
    if (!matchedBy) continue;
    entries.push({
      id: `visit:${ev.id}`,
      at: /^\d{4}-\d{2}-\d{2}$/.test(ev.start) ? noon(ev.start) : ev.start,
      kind: 'visit',
      title: ev.summary,
      detail: ev.location,
      href: ev.htmlLink,
      visit: { colorId: ev.colorId, end: ev.end, matchedBy },
    });
  }

  entries.sort((a, b) => b.at.localeCompare(a.at));

  const now = input.now.toISOString();
  const contacts = entries.filter((e) => (e.kind === 'text' || e.kind === 'call' || e.kind === 'email') && e.at <= now);
  const upcoming = entries.filter((e) => e.kind === 'visit' && e.at > now);
  const quotes = input.estimates;

  return {
    profile,
    entries,
    totals: {
      openQuotes: quotes.filter((e) => e.TxnStatus === 'Pending').reduce((s, e) => s + money(e.TotalAmt), 0),
      acceptedQuotes: quotes.filter((e) => e.TxnStatus === 'Accepted').reduce((s, e) => s + money(e.TotalAmt), 0),
      invoiced,
      paid,
      openBalance,
      overdueBalance,
    },
    lastContact: contacts[0],
    nextVisit: upcoming[upcoming.length - 1],
    sources: input.sources ?? [],
  };
}

// ── fetch ────────────────────────────────────────────────────────────

export interface TimelineDeps {
  qb: Pick<QuickBooksClient, 'getCustomer' | 'getEstimatesByCustomer' | 'getInvoicesByCustomer' | 'getPayment'>;
  quo?: Pick<QuoClient, 'listMessages' | 'listCalls'>;
  gmail?: Pick<GmailClient, 'listMessages'>;
  calendar?: Pick<GoogleCalendarClient, 'listEvents'>;
}

/** Quo pages are 50; a long customer relationship rarely passes a few hundred texts. */
const QUO_MAX_PAGES = 6;
const EMAIL_MAX = 40;
const MAX_PAYMENTS = 25;
/** Calendar window: from the first sign of the customer (capped) to this far ahead. */
const CAL_LOOKBACK_CAP_DAYS = 3 * 365;
const CAL_LOOKAHEAD_DAYS = 180;
const CAL_LEAD_DAYS = 30;

async function pages<T>(fetchPage: (token?: string) => Promise<{ data: T[]; nextPageToken?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < QUO_MAX_PAGES; i++) {
    const page = await fetchPage(token);
    out.push(...page.data);
    token = page.nextPageToken;
    if (!token || page.data.length === 0) break;
  }
  return out;
}

async function settle<T>(source: SourceStatus['source'], sources: SourceStatus[], run: () => Promise<T[]>): Promise<T[]> {
  try {
    const rows = await run();
    sources.push({ source, ok: true, count: rows.length });
    return rows;
  } catch (err) {
    sources.push({ source, ok: false, count: 0, error: (err as Error).message });
    return [];
  }
}

/**
 * Fetch everything we know about one QBO customer and build the timeline.
 * QBO is required (it defines the customer); every other source is
 * optional and degrades to a source error instead of failing the page.
 * Returns null when the customer doesn't exist.
 */
export async function getCustomerTimeline(
  deps: TimelineDeps,
  customerId: string,
  opts: { today: string; now?: Date },
): Promise<CustomerTimeline | null> {
  const now = opts.now ?? new Date();
  const customer = await deps.qb.getCustomer(customerId);
  if (!customer?.Id) return null;
  const withId = customer as QBCustomer & { Id: string };
  const profile = customerProfile(withId);
  const sources: SourceStatus[] = [];

  const [estimates, invoices] = await Promise.all([
    deps.qb.getEstimatesByCustomer(customerId),
    deps.qb.getInvoicesByCustomer(customerId),
  ]);
  const paymentIds = [
    ...new Set(invoices.flatMap((i) => (i.LinkedTxn ?? []).filter((l) => l.TxnType === 'Payment').map((l) => l.TxnId))),
  ].slice(0, MAX_PAYMENTS);

  const quo = deps.quo;
  const gmail = deps.gmail;
  const [payments, messages, calls, emails] = await Promise.all([
    Promise.all(paymentIds.map((id) => deps.qb.getPayment(id))).then((ps) => ps.filter((p): p is QBPayment => !!p)),
    quo
      ? settle('quo', sources, async () =>
          (await Promise.all(profile.phones.map((p) => pages((pageToken) => quo.listMessages({ participantE164: p, maxResults: 50, pageToken }))))).flat(),
        )
      : Promise.resolve([] as QuoMessage[]),
    quo
      ? settle('quo', sources, async () =>
          (await Promise.all(profile.phones.map((p) => pages((pageToken) => quo.listCalls({ participantE164: p, maxResults: 50, pageToken }))))).flat(),
        )
      : Promise.resolve([] as QuoCall[]),
    gmail && profile.emails.length
      ? settle('gmail', sources, () =>
          gmail.listMessages({
            query: `{${profile.emails.map((e) => `from:${e} to:${e} cc:${e}`).join(' ')}} -in:spam -in:trash`,
            maxResults: EMAIL_MAX,
          }),
        )
      : Promise.resolve([] as GmailMessage[]),
  ]);
  sources.unshift({ source: 'quickbooks', ok: true, count: estimates.length + invoices.length + payments.length });

  // Calendar window starts a month before the earliest thing we know about.
  const known = [
    ...estimates.map((e) => e.TxnDate),
    ...invoices.map((i) => i.TxnDate),
    ...messages.map((m) => m.createdAt.slice(0, 10)),
    ...calls.map((c) => c.createdAt.slice(0, 10)),
  ].filter((d): d is string => !!d).sort();
  const floor = new Date(now.getTime() - CAL_LOOKBACK_CAP_DAYS * DAY).toISOString();
  const first = known[0] ? new Date(Date.parse(`${known[0]}T00:00:00Z`) - CAL_LEAD_DAYS * DAY).toISOString() : floor;
  const calendar = deps.calendar;
  const events = calendar
    ? await settle('calendar', sources, () =>
        calendar.listEvents({
          timeMin: first > floor ? first : floor,
          timeMax: new Date(now.getTime() + CAL_LOOKAHEAD_DAYS * DAY).toISOString(),
        }),
      )
    : [];

  // Quo reported twice (texts + calls); fold into one status row.
  const quoRows = sources.filter((s) => s.source === 'quo');
  const merged: SourceStatus[] = sources.filter((s) => s.source !== 'quo');
  if (quoRows.length) {
    merged.push({
      source: 'quo',
      ok: quoRows.every((s) => s.ok),
      count: quoRows.reduce((n, s) => n + s.count, 0),
      error: quoRows.find((s) => s.error)?.error,
    });
  }

  const timeline = buildCustomerTimeline({
    customer: withId,
    estimates,
    invoices,
    payments,
    messages,
    calls,
    emails,
    events,
    today: opts.today,
    now,
    sources: merged,
  });
  // Calendar count = events that matched, not the window size.
  const cal = timeline.sources.find((s) => s.source === 'calendar');
  if (cal) cal.count = timeline.entries.filter((e) => e.kind === 'visit').length;
  return timeline;
}
