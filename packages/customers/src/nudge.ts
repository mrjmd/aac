import { daysBetween } from '@aac/shared-utils/eastern';
import type { TimelineEntry } from './timeline.js';

/**
 * Late-invoice nudge ladder (Matt, 11/03): due +7 QBO reminder email, +14
 * personal text, +30 phone call, +45 final written notice, then Matt
 * decides (collections or write-off). Each rung is satisfied by a touch of
 * that strength or stronger after the due date. QBO's automatic reminders
 * (on, as of 11/03: one near the due date, one 2-4 days later) count for
 * step 1 via their copies in Gmail; any rung can also be marked done by
 * hand (Done on the item); the item's fingerprint is the rung, so the next
 * rung reopens it. The final notice is always a manual rung.
 */
export type NudgeKind = 'reminder' | 'text' | 'call' | 'final';

export const NUDGE_LADDER: ReadonlyArray<{ day: number; kind: NudgeKind; label: string }> = [
  { day: 7, kind: 'reminder', label: 'QBO reminder email' },
  { day: 14, kind: 'text', label: 'Personal text' },
  { day: 30, kind: 'call', label: 'Phone call' },
  { day: 45, kind: 'final', label: 'Final written notice' },
];

const STRENGTH: Record<NudgeKind, number> = { reminder: 0, text: 1, call: 2, final: 3 };

/** Subjects of QBO's invoice reminder emails ("Invoice - Reminder: Your payment to Attack A Crack is due"). */
const QBO_REMINDER = /reminder.*(payment|invoice).*attack a crack|invoice past due for attack a crack/i;

/** Words that make an outbound text or email about money owed, not scheduling. */
const PAYMENT_WORDS =
  /\b(invoice|payment|pay|paid|balance|owe|owed|venmo|zelle|remit|outstanding|past due|overdue)\b|\b(a|the|your) check\b/i;
/** Quote and estimate mail mentions payment terms but isn't a nudge. */
const QUOTE_WORDS = /\b(estimate|quote)\b/i;

export interface NudgeTouch {
  at: string;
  kind: Exclude<NudgeKind, 'final'>;
  note: string;
}

export interface NudgeStatus {
  daysOverdue: number;
  /** Touches on or after the due date, oldest first. */
  history: NudgeTouch[];
  /** The rung now due (the first one reached and not yet covered), if any. */
  next: { kind: NudgeKind; label: string; day: number } | null;
  /** Reached rungs still uncovered after `next` (the ladder fell behind). */
  behind: number;
}

/** Which outbound timeline entries count as a nudge, and how strong. */
export function nudgeTouch(e: TimelineEntry): NudgeTouch | null {
  // QBO's automatic reminders come from quickbooks@notification.intuit.com, so
  // they read as inbound; their copies in Matt's Gmail still count as step 1.
  if (e.kind === 'email' && QBO_REMINDER.test(e.title)) return { at: e.at, kind: 'reminder', note: 'QBO automatic reminder' };
  if (e.direction !== 'out') return null;
  const text = `${e.title} ${e.detail ?? ''}`;
  if (e.kind === 'call') return { at: e.at, kind: 'call', note: e.title };
  if (e.kind === 'text' && PAYMENT_WORDS.test(text)) return { at: e.at, kind: 'text', note: (e.detail ?? '').slice(0, 120) };
  if (e.kind === 'email' && PAYMENT_WORDS.test(text) && !QUOTE_WORDS.test(e.title)) return { at: e.at, kind: 'reminder', note: e.title };
  return null;
}

/**
 * Where one overdue invoice sits on the ladder. `entries` is the customer's
 * timeline (any order); only outbound touches after `dueDate` count.
 */
export function nudgeStatus(dueDate: string, entries: TimelineEntry[], today: string): NudgeStatus {
  const daysOverdue = daysBetween(dueDate, today);
  const history = entries
    .filter((e) => e.at.slice(0, 10) >= dueDate.slice(0, 10))
    .map(nudgeTouch)
    .filter((t): t is NudgeTouch => t !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const strongest = history.reduce((m, t) => Math.max(m, STRENGTH[t.kind]), -1);
  const reached = NUDGE_LADDER.filter((r) => r.day <= daysOverdue);
  const open = reached.filter((r) => STRENGTH[r.kind] > strongest);
  const next = open[0];
  return {
    daysOverdue,
    history,
    next: next ? { kind: next.kind, label: next.label, day: next.day } : null,
    behind: Math.max(0, open.length - 1),
  };
}
