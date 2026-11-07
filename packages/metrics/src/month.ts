import type { QBInvoice, QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { CashPosition } from './cash.js';
import { SEASONAL_INDEX } from './scorecard.js';

/**
 * This month: revenue by month against the charter's May 2027 test, and the
 * tech #2 hire gates (analysis/00-charter.md, analysis/02-strategy/tech2-hiring-plan-2026-08.md).
 *
 * Revenue = QBO invoice totals by invoice date. That reproduces the hiring
 * plan's last-winter months (Nov $17.4k, Jan $6.0k, Feb $15.3k; December has
 * grown from $4.0k to $9.1k since the books were cleaned up in Oct).
 */

/** The charter's floor and target for rolling 3-month revenue, judged Mar-May 2027. */
export const CHARTER_FLOOR = 50_000;
export const CHARTER_TARGET = 80_000;
export const DECISION_WINDOW = ['2027-03', '2027-04', '2027-05'] as const;
/** The chart runs from a year before the hiring plan through the decision window. */
export const CHART_FROM = '2025-06';
export const CHART_TO = '2027-05';

/**
 * Seasonal revenue goals. The charter's floor and target are averages over
 * the decision window, so an average month's goal is goal ÷ the window's
 * mean index, and a month's goal is that × its own index (invoiced dollars,
 * the scorecard's `SEASONAL_INDEX`, re-fit each January). Over Mar-May the
 * seasonal goals average exactly the charter's numbers.
 */
const INVOICED = SEASONAL_INDEX.invoiced;
const indexOf = (month: string) => INVOICED[Number(month.slice(5, 7)) - 1]!;
export const DECISION_INDEX = DECISION_WINDOW.reduce((s, m) => s + indexOf(m), 0) / DECISION_WINDOW.length;

/** A month's share of a decision-window goal. */
export function seasonalGoal(month: string, goal: number): number {
  return Math.round((goal / DECISION_INDEX) * indexOf(month));
}

/** The seasonal goal averaged over a month and the two before it (May 2027 = the charter's number exactly). */
export function rolling3Goal(month: string, goal: number): number {
  return Math.round([month, addMonths(month, -1), addMonths(month, -2)].reduce((t, m) => t + seasonalGoal(m, goal), 0) / 3);
}

/** What a month's revenue would be in the decision window at the same level of demand. */
export function windowEquivalent(month: string, revenue: number): number {
  return Math.round((revenue / indexOf(month)) * DECISION_INDEX);
}

/** Tech #2 plan: winter revenue must beat last winter by this much. */
export const WINTER_MULTIPLIER = 1.5;
/** Booked this many weeks ahead, persistently. */
export const BOOKED_WEEKS_GATE = 3;
/** Vault targets from the plan (low end, high end). */
export const RESERVE_TARGET: [number, number] = [25_000, 30_000];
export const HIRE_FUND_TARGET: [number, number] = [33_000, 40_000];
export const VAULT_TARGET: [number, number] = [60_000, 70_000];
/** Relay sub-accounts (QBO names without the "Connecticut Sealers LLC - " prefix). */
const RESERVE_ACCOUNTS = /^(Payroll|Opex) \(/;
const HIRE_FUND_ACCOUNT = /^New Technician \(/;

export interface RevenueMonth {
  month: string;
  revenue: number;
  /** The charter's floor and target, seasonal (see `seasonalGoal`). */
  floor: number;
  target: number;
  /** The same goals averaged over this month and the two before: what the rolling line is judged against. */
  floor3: number;
  target3: number;
  /** Rolling 3-month average ending this month; null until three months exist or while the month is open. */
  rolling3: number | null;
  lastYear: number | null;
  /** The current month, still open. */
  open: boolean;
  /** Not started yet: only the seasonal goals (and last year) apply. */
  future: boolean;
}

export interface MonthlyRevenue {
  asOf: string;
  months: RevenueMonth[];
  /** Rolling 3-month average of the last three closed months. */
  rolling3: number | null;
  /** The seasonal floor and target averaged over those same three months. */
  rolling3Floor: number | null;
  rolling3Target: number | null;
  /** Those three months taken to the decision window at the same level of demand: the pace for Mar-May. */
  pace: number | null;
  /** Last 12 closed months. */
  ttm: number;
  ttmLastYear: number | null;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const round = (n: number) => Math.round(n);

/** Pure: invoice totals by month from `CHART_FROM` through `CHART_TO`, with the rolling average and last year. */
export function buildMonthlyRevenue(invoices: Pick<QBInvoice, 'TxnDate' | 'TotalAmt'>[], today: string): MonthlyRevenue {
  const byMonth = new Map<string, number>();
  for (const i of invoices) {
    const m = (i.TxnDate ?? '').slice(0, 7);
    if (m) byMonth.set(m, (byMonth.get(m) ?? 0) + (i.TotalAmt ?? 0));
  }
  const current = today.slice(0, 7);
  const rev = (m: string) => (m > current ? null : round(byMonth.get(m) ?? 0));
  const months = monthsBetween(CHART_FROM, CHART_TO).map((month): RevenueMonth => {
    const closed = month < current;
    const last3 = [month, addMonths(month, -1), addMonths(month, -2)].map(rev);
    return {
      month,
      revenue: rev(month) ?? 0,
      floor: seasonalGoal(month, CHARTER_FLOOR),
      target: seasonalGoal(month, CHARTER_TARGET),
      floor3: rolling3Goal(month, CHARTER_FLOOR),
      target3: rolling3Goal(month, CHARTER_TARGET),
      rolling3: closed && last3.every((v) => v != null) ? round((last3 as number[]).reduce((s, v) => s + v, 0) / 3) : null,
      lastYear: addMonths(month, -12) <= current ? rev(addMonths(month, -12)) : null,
      open: month === current,
      future: month > current,
    };
  });
  const lastClosed = addMonths(current, -1);
  const window3 = [addMonths(lastClosed, -2), addMonths(lastClosed, -1), lastClosed];
  const avg = (f: (m: string) => number) => round(window3.reduce((t, m) => t + f(m), 0) / 3);
  const sum = (from: string, to: string) => monthsBetween(from, to).reduce((s, m) => s + (byMonth.get(m) ?? 0), 0);
  const earliest = [...byMonth.keys()].sort()[0] ?? current;
  const rolling3 = months.find((m) => m.month === lastClosed)?.rolling3 ?? null;
  return {
    asOf: today,
    // Future months stay for their seasonal goals; their revenue is 0 and the chart draws no bar.
    months,
    rolling3,
    rolling3Floor: rolling3 == null ? null : rolling3Goal(lastClosed, CHARTER_FLOOR),
    rolling3Target: rolling3 == null ? null : rolling3Goal(lastClosed, CHARTER_TARGET),
    pace: rolling3 == null ? null : avg((m) => windowEquivalent(m, byMonth.get(m) ?? 0)),
    ttm: round(sum(addMonths(lastClosed, -11), lastClosed)),
    ttmLastYear: earliest <= addMonths(lastClosed, -23) ? round(sum(addMonths(lastClosed, -23), addMonths(lastClosed, -12))) : null,
  };
}

export interface WinterGate {
  /** Nov through Feb of the winter being judged, e.g. ['2026-11', ..., '2027-02']. */
  months: string[];
  thisWinter: number;
  lastWinter: number;
  /** The bar: last winter × 1.5. */
  needed: number;
  /** Months of this winter already started (the open month included in `thisWinter`). */
  monthsIn: number;
  /** Closed winter months against the same months last winter; null until one closes. */
  multiplierSoFar: number | null;
}

export interface Tech2Gates {
  winter: WinterGate;
  reserve: { balance: number; target: [number, number] };
  hireFund: { balance: number; target: [number, number] };
  vaults: { balance: number; target: [number, number] };
  booked: { latest: number | null; weeksAtGate: number; weeksSeen: number };
}

/** The winter that ends in the Feb after `today` (Nov-Feb); before Nov, the coming one. */
export function winterMonths(today: string): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const startYear = m >= 11 ? y : m <= 2 ? y - 1 : y;
  return monthsBetween(`${startYear}-11`, `${startYear + 1}-02`);
}

/**
 * Pure: the three gates the hire hangs on. Demand: this winter's revenue vs
 * last winter × 1.5, and weeks booked ahead (scorecard row, Monday mornings).
 * Cash: the Relay vaults as QBO registers carry them.
 */
export function buildTech2Gates(args: {
  invoices: Pick<QBInvoice, 'TxnDate' | 'TotalAmt'>[];
  cash: Pick<CashPosition, 'accounts'> | null;
  bookedWeeks: Array<number | null>;
  today: string;
}): Tech2Gates {
  const byMonth = new Map<string, number>();
  for (const i of args.invoices) {
    const m = (i.TxnDate ?? '').slice(0, 7);
    if (m) byMonth.set(m, (byMonth.get(m) ?? 0) + (i.TotalAmt ?? 0));
  }
  const months = winterMonths(args.today);
  const current = args.today.slice(0, 7);
  const started = months.filter((m) => m <= current);
  // A month still open would compare a few days against a whole month last year.
  const closed = started.filter((m) => m < current);
  const sum = (ms: string[]) => round(ms.reduce((s, m) => s + (byMonth.get(m) ?? 0), 0));
  const lastWinter = sum(months.map((m) => addMonths(m, -12)));
  const lastClosed = sum(closed.map((m) => addMonths(m, -12)));
  const thisWinter = sum(started);

  const balance = (re: RegExp) =>
    round((args.cash?.accounts ?? []).filter((a) => a.bank === 'Relay' && re.test(a.name)).reduce((s, a) => s + a.qboBalance, 0));
  const reserve = balance(RESERVE_ACCOUNTS);
  const hireFund = balance(HIRE_FUND_ACCOUNT);
  const seen = args.bookedWeeks.filter((w): w is number => w != null);

  return {
    winter: {
      months,
      thisWinter,
      lastWinter,
      needed: round(lastWinter * WINTER_MULTIPLIER),
      monthsIn: started.length,
      multiplierSoFar: closed.length && lastClosed > 0 ? Math.round((sum(closed) / lastClosed) * 100) / 100 : null,
    },
    reserve: { balance: reserve, target: RESERVE_TARGET },
    hireFund: { balance: hireFund, target: HIRE_FUND_TARGET },
    vaults: { balance: reserve + hireFund, target: VAULT_TARGET },
    booked: { latest: seen.length ? seen[seen.length - 1]! : null, weeksAtGate: seen.filter((w) => w >= BOOKED_WEEKS_GATE).length, weeksSeen: seen.length },
  };
}

/** Every invoice since the chart's first year-ago month. */
export function getMonthInvoices(qb: Pick<QuickBooksClient, 'listInvoicesSince'>): Promise<QBInvoice[]> {
  return qb.listInvoicesSince(`${addMonths(CHART_FROM, -12)}-01`);
}
