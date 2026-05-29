/**
 * Tool: getInvoiceSummary
 *
 * Aggregates QB invoices in a date range — total count + amount, paid vs
 * unpaid, and per-customer breakdown. Defaults to the current calendar
 * month when no range is given (the most common "how are we doing this
 * month?" query).
 *
 * Uses `listRecentInvoices(sinceISODate)` for the lower bound and filters
 * the upper bound client-side. `listRecentInvoices` is already capped per
 * its implementation; this tool doesn't paginate further.
 */

import type { ToolDeps } from './types.js';

export interface GetInvoiceSummaryInput {
  /** ISO date — created-at lower bound. Default = first day of current month UTC. */
  rangeStart?: string;
  /** ISO date — created-at upper bound. Default = now. */
  rangeEnd?: string;
}

export interface CustomerInvoiceTotal {
  customerId: string | null;
  customerName: string;
  count: number;
  amount: number;
  unpaidAmount: number;
}

export interface InvoiceSummaryResult {
  rangeStart: string;
  rangeEnd: string;
  totalCount: number;
  totalAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  byCustomer: CustomerInvoiceTotal[];
}

function startOfCurrentMonthUTC(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getInvoiceSummary(
  deps: ToolDeps,
  input: GetInvoiceSummaryInput = {},
): Promise<InvoiceSummaryResult> {
  const now = new Date();
  const rangeStart = input.rangeStart ?? startOfCurrentMonthUTC(now);
  const rangeEnd = input.rangeEnd ?? now.toISOString();
  const startMs = Date.parse(rangeStart);
  const endMs = Date.parse(rangeEnd);

  const invoices = await deps.qb.listRecentInvoices(rangeStart);

  let totalAmount = 0;
  let paidAmount = 0;
  let unpaidAmount = 0;
  const byCustomer = new Map<string, CustomerInvoiceTotal>();

  for (const invoice of invoices) {
    const createTime = invoice.MetaData?.CreateTime
      ? Date.parse(invoice.MetaData.CreateTime)
      : invoice.TxnDate
        ? Date.parse(invoice.TxnDate)
        : NaN;
    if (Number.isNaN(createTime)) continue;
    if (createTime < startMs || createTime > endMs) continue;

    const amount = invoice.TotalAmt ?? 0;
    const balance = invoice.Balance ?? 0;
    const paid = amount - balance;

    totalAmount += amount;
    paidAmount += paid;
    unpaidAmount += balance;

    const customerKey = invoice.CustomerRef?.value ?? 'unknown';
    const existing = byCustomer.get(customerKey);
    if (existing) {
      existing.count += 1;
      existing.amount += amount;
      existing.unpaidAmount += balance;
    } else {
      byCustomer.set(customerKey, {
        customerId: invoice.CustomerRef?.value ?? null,
        customerName: invoice.CustomerRef?.name ?? '(unknown)',
        count: 1,
        amount,
        unpaidAmount: balance,
      });
    }
  }

  return {
    rangeStart,
    rangeEnd,
    totalCount: Array.from(byCustomer.values()).reduce((s, c) => s + c.count, 0),
    totalAmount,
    paidAmount,
    unpaidAmount,
    byCustomer: Array.from(byCustomer.values()).sort((a, b) => b.amount - a.amount),
  };
}
