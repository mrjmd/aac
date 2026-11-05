/**
 * Inbound router settle timer (docs/plans/inbound-router.md). Shared by the
 * Quo webhook, which scores `inbound:due`, and the router, which drains it.
 *
 * Settle timer (owner, 2026-11-05): act as soon as a customer's burst calms
 * down. A burst is settled 2 minutes after the last customer event, and never
 * later than 10 minutes after the first, so a chatty thread still gets read.
 */

/** Quiet time after the last customer event. */
export const SETTLE_QUIET_MS = 2 * 60_000;
/** Hard cap from the first event of the burst. */
export const SETTLE_CAP_MS = 10 * 60_000;

/** When a burst that started at `firstMs` and last moved at `lastMs` counts as settled. */
export function settleDueAt(firstMs: number, lastMs: number): number {
  return Math.min(lastMs + SETTLE_QUIET_MS, firstMs + SETTLE_CAP_MS);
}
