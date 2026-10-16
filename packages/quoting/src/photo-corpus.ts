/**
 * photo-corpus — pure attribution logic for the photo→quote training
 * corpus (Phase 1 of docs/projects/photo-quote-training.md).
 *
 * A customer's photos (Quo MMS + emailed attachments) are joined to their
 * QBO estimates by date window. Repeat customers can have overlapping
 * windows — those cases are attributed to the nearest estimate and
 * flagged `ambiguousWith` so Phase 2 can review instead of guess.
 */

export interface CorpusEstimateRef {
  estimateId: string;
  docNumber: string;
  /** QBO TxnDate, YYYY-MM-DD. */
  txnDate: string;
}

export interface PhotoAttribution {
  /** Estimate the photo most plausibly belongs to; null = orphan. */
  estimateId: string | null;
  /** Days from photo to the estimate's TxnDate (positive = photo earlier). */
  daysBeforeEstimate: number | null;
  /** Other estimates whose windows also contained the photo. */
  ambiguousWith: string[];
}

export interface AttributionWindow {
  /** How many days before the estimate a photo may fall (default 45). */
  beforeDays?: number;
  /** How many days after the estimate a photo may fall (default 10). */
  afterDays?: number;
}

const DEFAULT_BEFORE_DAYS = 45;
const DEFAULT_AFTER_DAYS = 10;
const MS_PER_DAY = 86_400_000;

/** Whole days from `fromISO` (timestamp or date) to `toDate` (YYYY-MM-DD). */
export function daysBetween(fromISO: string, toDate: string): number {
  const from = Date.UTC(
    Number(fromISO.slice(0, 4)),
    Number(fromISO.slice(5, 7)) - 1,
    Number(fromISO.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toDate.slice(0, 4)),
    Number(toDate.slice(5, 7)) - 1,
    Number(toDate.slice(8, 10)),
  );
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * Attribute one photo (by its sent timestamp) to the customer's estimates.
 * Nearest estimate wins; every other in-window estimate is recorded as
 * ambiguous rather than silently dropped.
 */
export function attributePhoto(
  photoAtISO: string,
  estimates: CorpusEstimateRef[],
  window: AttributionWindow = {},
): PhotoAttribution {
  const beforeDays = window.beforeDays ?? DEFAULT_BEFORE_DAYS;
  const afterDays = window.afterDays ?? DEFAULT_AFTER_DAYS;

  const inWindow = estimates
    .map((e) => ({ e, days: daysBetween(photoAtISO, e.txnDate) }))
    .filter(({ days }) => days >= -afterDays && days <= beforeDays)
    .sort((a, b) => Math.abs(a.days) - Math.abs(b.days));

  if (inWindow.length === 0) {
    return { estimateId: null, daysBeforeEstimate: null, ambiguousWith: [] };
  }
  const [best, ...rest] = inWindow;
  return {
    estimateId: best.e.estimateId,
    daysBeforeEstimate: best.days,
    ambiguousWith: rest.map((r) => r.e.estimateId),
  };
}

export interface WindowedMessage {
  at: string;
  direction: 'incoming' | 'outgoing';
  text: string;
}

/**
 * Select the thread excerpt stored with an estimate: every message inside
 * the attribution window around its TxnDate. This is the Phase 2 input —
 * it carries the owner's own photo reactions and the customer's asks.
 */
export function messagesWithinWindow<T extends { at: string }>(
  messages: T[],
  txnDate: string,
  window: AttributionWindow = {},
): T[] {
  const beforeDays = window.beforeDays ?? DEFAULT_BEFORE_DAYS;
  const afterDays = window.afterDays ?? DEFAULT_AFTER_DAYS;
  return messages.filter((m) => {
    const days = daysBetween(m.at, txnDate);
    return days >= -afterDays && days <= beforeDays;
  });
}
