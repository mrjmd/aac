/**
 * Backend execution of the payment-status branch the technician picked at
 * Mark Complete. Resolves the customer's most-recent unpaid invoice and:
 *
 *   - cash / check        → create a QB Payment object linked to that invoice
 *   - card                → verify QB Balance == 0 (Payments-processed); else block
 *   - not_yet_paid        → call qb.sendInvoice() to email the customer
 *
 * Returns an outcome the server action can record on the completion
 * record and surface to the technician. Never throws on business
 * conditions (multi-invoice, no-invoice, etc.) — those become structured
 * { ok: false } results so the form can display them clearly.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBInvoice } from '@aac/api-clients/quickbooks';
import { createLogger } from '@aac/shared-utils/logger';
import { getPipedrive, getQuickBooks } from './clients';
import { matchEventToPerson, matchPersonToQBCustomer } from './customer-match';
import type { PaymentStatus } from './completion';

const log = createLogger('field:payment-branches');

export interface PaymentBranchSuccess {
  ok: true;
  invoiceId: string;
  /** QB Payment ID (Cash/Check only — null for Card and Not Yet Paid). */
  paymentId: string | null;
}

export interface PaymentBranchFailure {
  ok: false;
  error: string;
  /** True when the cause is something Matt needs to investigate, not Mike. */
  needsMattAttention: boolean;
}

export type PaymentBranchOutcome = PaymentBranchSuccess | PaymentBranchFailure;

export async function executePaymentBranch(
  event: CalendarEvent,
  paymentStatus: PaymentStatus,
): Promise<PaymentBranchOutcome> {
  const pd = getPipedrive();
  const qb = getQuickBooks();

  // 1) Event → PD person → QB customer
  const person = await matchEventToPerson(event, pd);
  if (!person) {
    return failure(`Couldn't match this job to a Pipedrive person. Please contact Matt.`, true);
  }
  const customer = await matchPersonToQBCustomer(person, qb);
  if (!customer || !customer.Id) {
    return failure(`Couldn't find a QuickBooks customer for ${person.name}. Please contact Matt.`, true);
  }
  const customerId: string = customer.Id;

  // 2) Find the customer's unpaid invoice(s)
  const recent = await qb.getInvoicesByCustomer(customerId);
  const openInvoices = recent.filter((inv) => (inv.Balance ?? 0) > 0);

  if (openInvoices.length === 0) {
    return failure(
      `No unpaid invoice found for ${customer.DisplayName ?? person.name}. Please contact Matt.`,
      true,
    );
  }
  if (openInvoices.length > 1) {
    return failure(
      `${openInvoices.length} unpaid invoices for ${customer.DisplayName ?? person.name}. Please contact Matt to choose the right one.`,
      true,
    );
  }
  const invoice = openInvoices[0];

  // 3) Branch
  try {
    switch (paymentStatus) {
      case 'cash':
      case 'check':
        return await applyCashOrCheckPayment(invoice, customerId, paymentStatus);
      case 'card':
        return await verifyCardPayment(invoice);
      case 'not_yet_paid':
        return await sendInvoiceNow(invoice);
    }
  } catch (err) {
    log.error('Payment branch threw', err as Error, { invoiceId: invoice.Id, paymentStatus });
    return failure(
      `QuickBooks rejected the request: ${err instanceof Error ? err.message : String(err)}. Please contact Matt.`,
      true,
    );
  }
}

async function applyCashOrCheckPayment(
  invoice: QBInvoice,
  customerId: string,
  status: 'cash' | 'check',
): Promise<PaymentBranchOutcome> {
  const qb = getQuickBooks();
  const methods = await qb.listPaymentMethods();
  const target = status === 'cash' ? 'cash' : 'check';
  const method = methods.find((m) => m.Name?.toLowerCase() === target);
  if (!method) {
    return failure(
      `QuickBooks doesn't have a "${target}" payment method configured. Please contact Matt.`,
      true,
    );
  }

  const balance = invoice.Balance ?? invoice.TotalAmt ?? 0;
  if (balance <= 0) {
    // Already paid — nothing to do. Treat as success.
    return { ok: true, invoiceId: invoice.Id, paymentId: null };
  }

  const payment = await qb.createPaymentForInvoice({
    invoiceId: invoice.Id,
    customerId,
    amount: balance,
    paymentMethodId: method.Id,
  });
  log.info('Recorded Cash/Check payment', { invoiceId: invoice.Id, paymentId: payment.Id, status });
  return { ok: true, invoiceId: invoice.Id, paymentId: payment.Id };
}

async function verifyCardPayment(invoice: QBInvoice): Promise<PaymentBranchOutcome> {
  const qb = getQuickBooks();
  const fresh = await qb.getInvoice(invoice.Id);
  if (!fresh) {
    return failure(`Could not refresh invoice ${invoice.Id} to verify card payment. Please contact Matt.`, true);
  }
  const balance = fresh.Balance ?? 0;
  if (balance > 0) {
    return failure(
      `QuickBooks still shows the invoice unpaid ($${balance.toFixed(2)}). Please contact Matt to verify the card payment before marking complete.`,
      true,
    );
  }
  return { ok: true, invoiceId: invoice.Id, paymentId: null };
}

async function sendInvoiceNow(invoice: QBInvoice): Promise<PaymentBranchOutcome> {
  const qb = getQuickBooks();
  await qb.sendInvoice(invoice.Id);
  log.info('Sent invoice email', { invoiceId: invoice.Id });
  return { ok: true, invoiceId: invoice.Id, paymentId: null };
}

function failure(error: string, needsMattAttention: boolean): PaymentBranchFailure {
  return { ok: false, error, needsMattAttention };
}
