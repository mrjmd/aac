import type { LeakRow, LeakStage, Scope } from './types.js';

/**
 * Leak value, the funnel study's method (analysis/02-strategy/funnel-baseline-2026-11.md
 * §1): one average lead is worth quotes per lead × win rate × average won
 * deal = 0.749 × 0.542 × $2,073 = $842 of expected work. Re-fit with the
 * study each January.
 */
export const STD_LEAD_VALUE = 842;
export const WIN_RATE = 0.542;
export const AVG_WON_DEAL = 2073;
/** About 1 in 4 inbound contacts is a real in-scope lead: a bare missed call is worth a quarter lead. */
export const MISSED_CALL_REAL_RATE = 0.25;

/** Likely ticket by scope, from the pricing policy (anchor $1,175). Unknown scope falls back to the standard lead. */
export const SCOPE_TICKET: Record<Exclude<Scope, 'unknown'>, number> = {
  crack: 1175,
  bulkhead: 1175,
  pipe: 875,
  stairs: 1475,
  slab: 975,
  garage_floor: 2000,
  multi: 2000,
};

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Expected work lost on one lead. When scope is known the quote is ours to
 * send, so value = likely ticket × win rate. An assessed lead with unknown
 * scope is an average won deal × win rate.
 */
export function leakValue(stage: LeakStage, scope: Scope, missedOnly: boolean): { value: number; basis: string } {
  if (missedOnly) {
    const value = Math.round(STD_LEAD_VALUE * MISSED_CALL_REAL_RATE);
    return { value, basis: `missed call: ${usd(STD_LEAD_VALUE)} lead × 25% real-lead rate` };
  }
  if (scope !== 'unknown') {
    const ticket = SCOPE_TICKET[scope];
    return { value: Math.round(ticket * WIN_RATE), basis: `${usd(ticket)} ${scope.replace('_', ' ')} × 54% win rate` };
  }
  if (stage === 'assessed') {
    return { value: Math.round(AVG_WON_DEAL * WIN_RATE), basis: `${usd(AVG_WON_DEAL)} average job × 54% win rate` };
  }
  return { value: STD_LEAD_VALUE, basis: 'standard lead (scope unknown)' };
}

/** The rows still open: a row marked handled stays hidden until its thread moves. */
export function openRows(rows: LeakRow[], handled: Record<string, string> | null): LeakRow[] {
  return rows.filter((r) => handled?.[r.phone] !== r.lastActivityAt);
}

export function totalValue(rows: LeakRow[]): number {
  return rows.reduce((s, r) => s + r.value, 0);
}
