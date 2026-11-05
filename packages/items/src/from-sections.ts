import { createHash } from 'node:crypto';
import type { ItemCandidate } from './types.js';

/**
 * The triage sections that live outside findings[] (tools/src/triage/
 * sections.ts), as items. Each interface is the subset the adapter reads.
 */

const fp = (...facts: Array<string | number | undefined>) =>
  createHash('sha256').update(facts.map((f) => f ?? '').join('|')).digest('hex').slice(0, 16);

export interface AwaitingQuote {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  channel: string;
  lastInboundAt: string;
  daysWaiting: number;
  snippet: string;
}

/**
 * A customer with an open quote spoke last and got no answer. The follow-up
 * bot stays out of these by design, so they are Matt's. A newer inbound
 * message reopens a done or dismissed one.
 */
export function fromAwaitingQuote(a: AwaitingQuote): ItemCandidate {
  return {
    key: `aw:${a.doc}`,
    detector: 'AW',
    area: 'sales',
    lane: 'needs-you',
    severity: a.daysWaiting >= 14 ? 'red' : 'yellow',
    title: `${a.customer} is waiting on your reply, ${a.daysWaiting}d (#${a.doc})`,
    customer: a.customer,
    phone: a.phone,
    amount: a.amount,
    ...(a.snippet ? { evidence: `Their last ${a.channel}: "${a.snippet}"` } : {}),
    action: 'Reply (the follow-up bot waits for you)',
    fingerprint: fp(a.lastInboundAt),
  };
}

export interface FollowupDraft {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  ageDays: number;
  tier: string;
  draft: string;
  whyNow: string;
  queuedAt: string;
}

/** A stale-quote follow-up text drafted by automation: confirm lane. */
export function fromFollowupDraft(d: FollowupDraft, notYetSent: boolean): ItemCandidate {
  return {
    key: `fup:${d.doc}`,
    detector: 'FUP',
    area: 'sales',
    lane: 'confirm',
    severity: notYetSent ? 'yellow' : 'info',
    title: `Follow-up text ready: ${d.customer}, #${d.doc} (${d.ageDays}d old)`,
    customer: d.customer,
    phone: d.phone,
    amount: d.amount,
    detail: `"${d.draft}"`,
    evidence: notYetSent ? `${d.whyNow} Queued ${d.queuedAt.slice(0, 10)}, not sent yet.` : d.whyNow,
    action: 'Copy into Quo and send',
    fingerprint: fp(d.queuedAt),
  };
}

export interface FunnelFlag {
  kind: string;
  doc: string;
  customer: string;
  amount: number;
  detail: string;
}

const FLAG_TITLE: Record<string, string> = {
  'flip-accepted': 'Booked but the quote is still Pending',
  'recommend-close': 'Quote looks dead, close it?',
  'needs-call': 'Needs a call, not a text',
};

/** A stale-quote funnel flag. Capacity holds are parked work, not items (null). */
export function fromFunnelFlag(f: FunnelFlag): ItemCandidate | null {
  if (f.kind === 'capacity-hold') return null;
  return {
    key: `fupflag:${f.kind}:${f.doc}`,
    detector: 'FUPF',
    area: 'sales',
    lane: 'needs-you',
    severity: f.kind === 'flip-accepted' || f.kind === 'recommend-close' ? 'yellow' : 'info',
    title: `${FLAG_TITLE[f.kind] ?? f.kind}: ${f.customer}, #${f.doc}`,
    customer: f.customer,
    amount: f.amount,
    detail: f.detail,
    fingerprint: fp(f.kind, f.amount, f.detail),
  };
}

export interface BotDraft {
  at: string;
  trigger: string;
  phone: string;
  /** From the edit-harvester's label, when the draft has one. */
  customer?: string;
  outcome: string;
  createdDoc?: string;
  total?: number;
  why?: string;
  scopeItems?: string[];
}

/**
 * A quote the bot drafted (or failed to) in the last 7 days. Created or
 * updated drafts go to the confirm lane; failures need Matt. Skipped and
 * other non-draft outcomes are not items (null).
 */
export function fromBotDraft(r: BotDraft): ItemCandidate | null {
  const made = r.outcome === 'created' || r.outcome === 'updated';
  if (!made && r.outcome !== 'draft-failed') return null;
  const scope = r.scopeItems?.length ? ` Scope: ${r.scopeItems.join(', ')}.` : '';
  return {
    key: made ? `qd:${r.createdDoc ?? r.at}` : `qdfail:${r.phone}:${r.at}`,
    detector: 'QD',
    area: 'sales',
    lane: made ? 'confirm' : 'needs-you',
    severity: made ? 'info' : 'yellow',
    title: made
      ? `Bot quote draft #${r.createdDoc ?? '?'} ${r.outcome === 'updated' ? 'updated' : 'ready'}: ${r.customer ?? r.phone}`
      : `Bot quote draft failed (${r.trigger}): ${r.customer ?? r.phone}`,
    ...(r.customer ? { customer: r.customer } : {}),
    phone: r.phone,
    ...(r.total !== undefined ? { amount: r.total } : {}),
    ...(r.why || scope ? { detail: `${r.why ?? ''}${scope}`.trim() } : {}),
    action: made ? 'Review it in QBO (Pending), then send or edit' : 'Quote it by hand',
    fingerprint: fp(r.outcome, r.total, r.at),
  };
}

export interface InvoiceNudge {
  invoiceId: string;
  doc: string;
  customer: string;
  phone?: string;
  balance: number;
  dueDate: string;
  daysOverdue: number;
  next: { kind: 'reminder' | 'text' | 'call' | 'final'; label: string; day: number };
  /** Reached rungs still uncovered after `next`. */
  behind: number;
  history: Array<{ at: string; kind: string; note: string }>;
}

const NUDGE_ACTION: Record<InvoiceNudge['next']['kind'], string> = {
  reminder: 'Send a QBO reminder, then Done',
  text: 'Text them about the balance',
  call: 'Call them',
  final: 'Send the final written notice, then decide: collections or write-off',
};

/**
 * An overdue invoice whose next nudge is due (the 7/14/30/45 ladder). Keyed
 * like triage's D3 overdue item so state carries over. The fingerprint is
 * the rung and balance: Done on a rung hides it until the next rung comes
 * due or a payment changes the balance.
 */
export function fromInvoiceNudge(n: InvoiceNudge): ItemCandidate {
  const last = n.history.at(-1);
  const lastLine = last
    ? `Last nudge: ${last.kind} ${last.at.slice(0, 10)}${last.note ? ` ("${last.note}")` : ''}. ${n.history.length} since it came due.`
    : `No nudge from you since it came due ${n.dueDate}.`;
  return {
    key: `d3:${n.invoiceId}`,
    detector: 'NUDGE',
    area: 'money',
    lane: 'needs-you',
    severity: n.next.kind === 'call' || n.next.kind === 'final' ? 'red' : 'yellow',
    title: `${n.next.label} due: ${n.customer} #${n.doc}, ${n.daysOverdue}d overdue`,
    customer: n.customer,
    ...(n.phone ? { phone: n.phone } : {}),
    amount: n.balance,
    detail: `${lastLine}${n.behind ? ` The ladder is ${n.behind} step${n.behind === 1 ? '' : 's'} behind.` : ''}`,
    evidence: 'Confirm no unlogged cash or check before nudging.',
    action: NUDGE_ACTION[n.next.kind],
    fingerprint: fp(n.next.kind, n.balance),
    sensitive: 'money',
  };
}

export interface RuleReview {
  id: string;
  /** Short label, e.g. "Resurfacing pause". */
  label: string;
  text: string;
  reviewBy: string; // YYYY-MM-DD
  untilWhen?: string;
}

/**
 * A time-bound owner policy (can-help store) whose review date has arrived:
 * ask Matt whether it still holds. Null before the date. Moving the review
 * date or changing the rule reopens it.
 */
export function fromRuleReview(r: RuleReview, today: string): ItemCandidate | null {
  if (r.reviewBy > today) return null;
  return {
    key: `rule:${r.id}`,
    detector: 'RULE',
    area: 'admin',
    lane: 'needs-you',
    severity: 'yellow',
    title: `Does "${r.label}" still hold? Review date ${r.reviewBy}`,
    detail: r.text,
    ...(r.untilWhen ? { evidence: `Set to end when ${r.untilWhen}` } : {}),
    action: 'Keep it (move the review date), edit it, or end it on Referrals',
    link: '/referrals#policies',
    fingerprint: fp(r.reviewBy, r.text),
  };
}
