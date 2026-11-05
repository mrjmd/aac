import type { QBAccount, QBInvoice, QuickBooksClient } from '@aac/api-clients/quickbooks';
import { daysBetween } from '@aac/shared-utils/eastern';

export interface CashAccount {
  id: string;
  /** Short label, e.g. "Opex (1081)". */
  name: string;
  bank: 'Relay' | 'Beacon' | 'Other';
  /** QBO register balance (equals the bank only once the register is reconciled). */
  qboBalance: number;
  /** Latest posted transaction date (YYYY-MM-DD), or null if nothing in the window. */
  postedThrough: string | null;
  /** Days between postedThrough and today. */
  daysBehind: number | null;
}

export interface CashPosition {
  asOf: string;
  accounts: CashAccount[];
  /** Sum of Relay register balances. */
  relayTotal: number;
  /** Customer payments recorded in QBO but not yet deposited. */
  undeposited: number;
  ar: {
    openTotal: number;
    openCount: number;
    overdueTotal: number;
    overdueCount: number;
    /** Oldest due date among overdue invoices. */
    oldestDue: string | null;
  };
  /** Window searched for posting dates. */
  postingWindowStart: string;
}

const RELAY_PREFIX = /^Connecticut Sealers LLC\s*-\s*/i;

function bankOf(name: string): CashAccount['bank'] {
  if (RELAY_PREFIX.test(name)) return 'Relay';
  if (/^Business Checking \(1082\)/i.test(name)) return 'Beacon';
  return 'Other';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: shape QBO accounts, posting dates and open invoices into the Money view. */
export function buildCashPosition(args: {
  accounts: QBAccount[];
  postingDates: Record<string, string>;
  openInvoices: QBInvoice[];
  today: string;
  postingWindowStart: string;
}): CashPosition {
  const { today } = args;
  const bankAccounts = args.accounts.filter((a) => a.AccountType === 'Bank' && a.Active !== false);
  const order = { Relay: 0, Beacon: 1, Other: 2 } as const;
  const accounts: CashAccount[] = bankAccounts
    .map((a) => {
      const postedThrough = args.postingDates[a.Id] ?? null;
      return {
        id: a.Id,
        name: a.Name.replace(RELAY_PREFIX, ''),
        bank: bankOf(a.Name),
        qboBalance: round2(a.CurrentBalance ?? 0),
        postedThrough,
        daysBehind: postedThrough ? daysBetween(postedThrough, today) : null,
      };
    })
    .sort((x, y) => order[x.bank] - order[y.bank] || y.qboBalance - x.qboBalance);

  const undepositedAccount = args.accounts.find((a) => /undeposited/i.test(a.Name));
  const overdue = args.openInvoices.filter((i) => i.DueDate && i.DueDate < today);
  return {
    asOf: today,
    accounts,
    relayTotal: round2(accounts.filter((a) => a.bank === 'Relay').reduce((s, a) => s + a.qboBalance, 0)),
    undeposited: round2(undepositedAccount?.CurrentBalance ?? 0),
    ar: {
      openTotal: round2(args.openInvoices.reduce((s, i) => s + (i.Balance ?? 0), 0)),
      openCount: args.openInvoices.length,
      overdueTotal: round2(overdue.reduce((s, i) => s + (i.Balance ?? 0), 0)),
      overdueCount: overdue.length,
      oldestDue: overdue.reduce<string | null>((m, i) => (!m || (i.DueDate ?? m) < m ? i.DueDate ?? m : m), null),
    },
    postingWindowStart: args.postingWindowStart,
  };
}

/** Fetch from QBO and build. `today` is YYYY-MM-DD in America/New_York. */
export async function getCashPosition(qb: QuickBooksClient, today: string, windowDays = 90): Promise<CashPosition> {
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const [accounts, postingDates, openInvoices] = await Promise.all([
    qb.listAccounts(),
    qb.latestPostingDates(start, today),
    qb.listOpenInvoices(),
  ]);
  return buildCashPosition({ accounts, postingDates, openInvoices, today, postingWindowStart: start });
}
