/**
 * Server-side helpers for the "At the bank" deposit interface.
 *
 * The list of undeposited payments is QB's Undeposited Funds register —
 * payments that have a Payment record in QB but haven't yet been pulled
 * into a Deposit transaction. Once Mike makes the physical bank deposit,
 * the field app POSTs a Deposit grouping the selected payments and they
 * disappear from this list.
 *
 * QB quirk: even DEPOSITED payments retain `DepositToAccountRef = '8'`
 * in their record (the field reflects where they ORIGINALLY went, not
 * where they currently are). So we have to fetch the Deposits separately
 * and subtract their linked Payments to get the truly-undeposited set.
 */

import type { QBAccount, QBPayment, QBPaymentMethod } from '@aac/api-clients/quickbooks';
import { getQuickBooks } from './clients';

/** Stable across QBO realms — Undeposited Funds is always account 8. */
const UNDEPOSITED_FUNDS_ID = '8';

/** How far back to scan for unposited payments. Anything older is almost certainly an old data error. */
const PAYMENT_HISTORY_MONTHS = 6;

export interface UndepositedPayment {
  /** QB Payment ID */
  id: string;
  /** Customer name from the Payment's CustomerRef */
  customerName: string;
  /** Amount in dollars (Payment.TotalAmt). Same value must be used as the DepositLine amount. */
  amount: number;
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Resolved name from the PaymentMethod lookup ("Cash", "Check", etc.) */
  method: string;
  /** Reference number Mike typed at payment time — usually a check number. */
  refNum?: string;
}

export async function getUndepositedPayments(): Promise<UndepositedPayment[]> {
  const qb = getQuickBooks();

  // 1) Pull all Payments in the recent window (QB doesn't let us filter by DepositToAccountRef in SQL)
  const since = isoMonthsAgo(PAYMENT_HISTORY_MONTHS);
  const paymentsResp = await qb.query<{ QueryResponse?: { Payment?: QBPayment[] } }>(
    `SELECT * FROM Payment WHERE TxnDate >= '${since}' ORDER BY TxnDate DESC MAXRESULTS 500`,
  );
  const allRecent = paymentsResp.QueryResponse?.Payment ?? [];
  const candidates = allRecent.filter((p) => p.DepositToAccountRef?.value === UNDEPOSITED_FUNDS_ID);

  // 2) Build set of Payment IDs already pulled into a Deposit
  const deposits = await qb.listRecentDeposits(500);
  const depositedIds = new Set<string>();
  for (const d of deposits) {
    for (const line of d.Line ?? []) {
      for (const lt of line.LinkedTxn ?? []) {
        if (lt.TxnType === 'Payment') depositedIds.add(lt.TxnId);
      }
    }
  }

  // 3) Truly undeposited = candidates minus already-deposited
  const undeposited = candidates.filter((p) => !depositedIds.has(p.Id));

  // 4) Resolve PaymentMethod names
  const methods = await qb.listPaymentMethods();
  const methodById = new Map<string, QBPaymentMethod>(methods.map((m) => [m.Id, m]));

  return undeposited
    .map((p) => ({
      id: p.Id,
      customerName: p.CustomerRef?.name ?? '(unknown customer)',
      amount: p.TotalAmt,
      date: p.TxnDate ?? '',
      method: p.PaymentMethodRef ? methodById.get(p.PaymentMethodRef.value)?.Name ?? 'Other' : 'Other',
      refNum: p.PaymentRefNum,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getBankAccounts(): Promise<QBAccount[]> {
  const qb = getQuickBooks();
  const accts = await qb.listAccounts({ type: 'Bank' });
  // Sort by balance desc so the most-used account floats to the default-selected slot
  return accts.sort((a, b) => (b.CurrentBalance ?? 0) - (a.CurrentBalance ?? 0));
}

function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}
