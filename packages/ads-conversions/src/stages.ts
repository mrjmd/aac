/**
 * Pure: which funnel stages a matched ad click has reached, and when.
 *
 *  - Real lead: within 14 days of first contact, an inbound text with a
 *    photo or a job word, a call of 60s+, or an inbound voicemail; or any
 *    quote sent. Same rule as the funnel ledger (analysis/data/funnel).
 *  - Quote sent: first QBO estimate after the tap that was emailed or
 *    accepted. Value = its total.
 *  - Won job: first QBO invoice after the tap. Value = its total.
 *
 * One conversion per stage per phone, keyed by a stable orderId, so a
 * re-run never double counts.
 */
import type { QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import type { AdClick } from './match.js';

export type Stage = 'lead' | 'quote' | 'won';

export interface ActivityMessage {
  at: Date;
  direction: 'incoming' | 'outgoing';
  text: string;
  hasMedia: boolean;
}

export interface ActivityCall {
  at: Date;
  direction: 'incoming' | 'outgoing';
  durationSec: number;
  voicemail: boolean;
}

export interface StageHit {
  stage: Stage;
  orderId: string;
  at: Date;
  value?: number;
}

const DAY = 86_400_000;
export const REAL_LEAD_WINDOW_MS = 14 * DAY;
/** Google rejects clicks older than 90 days. */
export const CLICK_MAX_AGE_MS = 90 * DAY;

export const REAL_RE =
  /crack|basement|foundation|leak|seep|water|bulkhead|quote|estimate|concrete|sump|repair|pool|patio|garage|wall|floor|step|stair|resurfac|driveway|walkway/i;
const OPTOUT_RE = /^\s*(stop|unsubscribe|remove|wrong number|no thanks?|not interested)\b/i;

const SENT_STATUSES = new Set(['Accepted', 'Closed', 'Converted']);

export function realLeadAt(
  click: AdClick,
  messages: ActivityMessage[],
  calls: ActivityCall[],
): Date | null {
  const start = Date.parse(click.contactAt) - 60_000;
  const end = start + REAL_LEAD_WINDOW_MS;
  const inWindow = (d: Date) => d.getTime() >= start && d.getTime() <= end;
  const hits: Date[] = [];
  for (const m of messages) {
    if (m.direction !== 'incoming' || !inWindow(m.at) || OPTOUT_RE.test(m.text)) continue;
    if (m.hasMedia || REAL_RE.test(m.text)) hits.push(m.at);
  }
  for (const c of calls) {
    if (!inWindow(c.at)) continue;
    if (c.durationSec >= 60 || (c.direction === 'incoming' && c.voicemail)) hits.push(c.at);
  }
  return hits.length ? new Date(Math.min(...hits.map((d) => d.getTime()))) : null;
}

function createdAt(doc: { MetaData?: { CreateTime?: string }; TxnDate?: string }): Date | null {
  const raw = doc.MetaData?.CreateTime ?? doc.TxnDate;
  return raw ? new Date(raw) : null;
}

/** An estimate made more than a day before the tap: this is a returning customer. */
export function isExistingCustomer(click: AdClick, estimates: QBEstimate[]): boolean {
  const cutoff = Date.parse(click.tapAt) - DAY;
  return estimates.some((e) => {
    const at = createdAt(e);
    return at !== null && at.getTime() < cutoff;
  });
}

export function quoteSent(click: AdClick, estimates: QBEstimate[]): StageHit | null {
  const cutoff = Date.parse(click.tapAt) - DAY;
  const sent = estimates
    .map((e) => ({ e, made: createdAt(e) }))
    .filter(({ e, made }) =>
      made !== null &&
      made.getTime() >= cutoff &&
      (e.EmailStatus === 'EmailSent' || SENT_STATUSES.has(e.TxnStatus ?? '')),
    )
    .map(({ e, made }) => ({
      e,
      at: e.DeliveryInfo?.DeliveryTime ? new Date(e.DeliveryInfo.DeliveryTime) : (made as Date),
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = sent[0];
  if (!first) return null;
  return { stage: 'quote', orderId: `quote:${click.phone}`, at: first.at, value: first.e.TotalAmt ?? 0 };
}

export function wonJob(click: AdClick, invoices: QBInvoice[]): StageHit | null {
  const cutoff = Date.parse(click.tapAt) - DAY;
  const first = invoices
    .map((inv) => ({ inv, at: createdAt(inv) }))
    .filter(({ inv, at }) => at !== null && at.getTime() >= cutoff && (inv.TotalAmt ?? 0) > 0)
    .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime())[0];
  if (!first) return null;
  return { stage: 'won', orderId: `won:${click.phone}`, at: first.at as Date, value: first.inv.TotalAmt ?? 0 };
}

/** All stages reached, with conversion times clamped to (tap, now]. */
export function stagesFor(
  click: AdClick,
  activity: { messages: ActivityMessage[]; calls: ActivityCall[] },
  estimates: QBEstimate[],
  invoices: QBInvoice[],
  now: Date,
): StageHit[] {
  const quote = quoteSent(click, estimates);
  const won = wonJob(click, invoices);
  const hits: StageHit[] = [];
  if (!isExistingCustomer(click, estimates)) {
    const leadCandidates = [realLeadAt(click, activity.messages, activity.calls), quote?.at].filter(
      (d): d is Date => d instanceof Date,
    );
    if (leadCandidates.length) {
      const at = new Date(Math.min(...leadCandidates.map((d) => d.getTime())));
      hits.push({ stage: 'lead', orderId: `lead:${click.phone}`, at });
    }
  }
  if (quote) hits.push(quote);
  if (won) hits.push(won);
  // Google wants the conversion after the click; a quote dated the morning
  // of the tap (TxnDate only) would otherwise land before it.
  const floor = Date.parse(click.tapAt) + 60_000;
  return hits
    .map((h) => ({ ...h, at: new Date(Math.max(h.at.getTime(), floor)) }))
    .filter((h) => h.at.getTime() <= now.getTime());
}
