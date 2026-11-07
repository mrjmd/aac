import { createHash } from 'node:crypto';
import { daysBetween } from '@aac/shared-utils/eastern';
import type { ItemCandidate, Severity } from './types.js';

/**
 * Important dates (README §6, the obligations registry's first screen):
 * insurance, licenses, filings, taxes, memberships and renewals. One entry
 * per obligation with its next due date; Done rolls it to the next one.
 * Within `leadDays` of the date it becomes an item pinned to that day, so it
 * shows on This week and in Get ahead of, and on Today once it's close.
 */

export type ObligationCategory = 'insurance' | 'license' | 'entity' | 'tax' | 'membership' | 'software' | 'vehicle' | 'safety';
export type Repeat = 'none' | 'quarterly' | 'yearly' | '2-yearly' | '4-yearly';

export interface Obligation {
  id: string;
  title: string;
  category: ObligationCategory;
  /** Next due date, YYYY-MM-DD; null = we don't know it yet (listed under "needs a date", never an item). */
  due: string | null;
  repeat: Repeat;
  /** Days before `due` it starts showing as an item. */
  leadDays: number;
  /** Who files or pays it when it isn't Matt (Datapay, the CPA, Titan). Then Matt only checks it happened. */
  handledBy?: string;
  cost?: string;
  notes?: string;
  /** Where the date came from (an email, a QBO payment). */
  source?: string;
  /** Matt confirmed the date; unconfirmed ones are guesses from past payments and emails. */
  confirmed: boolean;
  sensitive?: 'money' | 'legal';
  /** The last time it was done (YYYY-MM-DD). */
  lastDone?: string;
  /** A one-off that's done: stays on the list, never an item again. */
  closed?: boolean;
}

export const OBLIGATION_KEY_PREFIX = 'ob:';
export const DATE_DETECTOR = 'DATE';
export const DEFAULT_LEAD_DAYS = 14;

const MONTHS: Record<Repeat, number> = { none: 0, quarterly: 3, yearly: 12, '2-yearly': 24, '4-yearly': 48 };

/** The due date after `due` for a repeating obligation (null for one-offs). Month ends clamp (Jan 31 → Apr 30). */
export function nextDue(due: string, repeat: Repeat): string | null {
  const months = MONTHS[repeat];
  if (!months) return null;
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Pure: mark one done on `today`. Repeating ones move to their next date; a one-off closes. */
export function markObligationDone(o: Obligation, today: string): Obligation {
  const next = o.due ? nextDue(o.due, o.repeat) : null;
  return next ? { ...o, lastDone: today, due: next } : { ...o, lastDone: today, closed: true };
}

/**
 * Pure: the item for an obligation inside its lead window, else null. Red
 * from the due date on, yellow inside a week, info before. Keyed by the
 * due date, so the next cycle is a new item and moving the date reopens it.
 */
export function fromObligation(o: Obligation, today: string): ItemCandidate | null {
  if (!o.due || o.closed) return null;
  const days = daysBetween(today, o.due);
  if (days > o.leadDays) return null;
  const severity: Severity = days <= 0 ? 'red' : days <= 7 ? 'yellow' : 'info';
  const when = days < 0 ? `${-days}d overdue` : days === 0 ? 'due today' : `due in ${days}d`;
  const candidate: ItemCandidate = {
    key: `${OBLIGATION_KEY_PREFIX}${o.id}:${o.due}`,
    detector: DATE_DETECTOR,
    area: 'admin',
    lane: 'needs-you',
    severity,
    title: `${o.title} (${when})`,
    // Noon Eastern-ish, so the day never slips across midnight.
    dueOn: `${o.due}T16:00:00.000Z`,
    action: o.handledBy ? `Check ${o.handledBy} did it, then mark it done on Admin` : 'Do it, then mark it done on Admin',
    link: '/admin#dates',
    fingerprint: createHash('sha256').update(`${o.title}|${o.due}`).digest('hex').slice(0, 16),
  };
  const detail = [o.cost, o.notes, o.confirmed ? '' : 'Date not confirmed yet.'].filter(Boolean).join(' ');
  if (detail) candidate.detail = detail;
  if (o.source) candidate.evidence = `From: ${o.source}`;
  if (o.sensitive) candidate.sensitive = o.sensitive;
  return candidate;
}
