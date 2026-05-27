/**
 * Backend execution of the payment-status branch the technician picked at
 * Mark Complete. Resolves the customer's relevant invoice based on the
 * branch:
 *
 *   - cash / check        → expects an OPEN invoice; creates a QB Payment
 *                           linked to it (marks paid).
 *   - card                → expects the MOST-RECENT invoice to already be paid
 *                           by a credit-card PaymentMethod; verifies that. If
 *                           still unpaid, or paid by Cash/Check (wrong button),
 *                           blocks and alerts.
 *   - not_yet_paid        → expects an OPEN invoice; calls sendInvoice().
 *
 * Returns an outcome the server action can record on the completion
 * record and surface to the technician. Never throws on business
 * conditions (multi-invoice, no-invoice, etc.) — those become structured
 * { ok: false } results so the form can display them clearly.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type {
  QBInvoice,
  QBCustomer,
  QuickBooksClient,
  QBPaymentMethod,
} from '@aac/api-clients/quickbooks';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';
import { createLogger } from '@aac/shared-utils/logger';
import { getPipedrive, getQuickBooks } from './clients';
import { matchEventToPerson, matchPersonToQBCustomer } from './customer-match';
import type { PaymentStatus } from './completion';

const log = createLogger('field:payment-branches');

/**
 * How far back to consider "recent" invoices for matching this job.
 * Cron A creates an invoice the day estimates are accepted, so the relevant
 * invoice should be within a day or two. 14 days is a generous safety margin
 * (handles weekend jobs / time-zone slop / delayed estimate acceptance) while
 * still excluding stale invoices from months ago.
 */
const RECENT_INVOICE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface PaymentBranchSuccess {
  ok: true;
  invoiceId: string;
  /** QB Payment ID (Cash/Check creates one; Card verifies existing; Not-Yet-Paid is null). */
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
  const displayName = customer.DisplayName ?? person.name;

  // 2) Fetch this customer's recent invoices (any balance — branches filter)
  const all = await qb.getInvoicesByCustomer(customerId);
  const recent = filterRecent(all);

  if (recent.length === 0) {
    return failure(
      `No recent invoice found for ${displayName}. Please contact Matt.`,
      true,
    );
  }

  // 3) Branch — each branch picks the invoice it cares about and acts.
  try {
    switch (paymentStatus) {
      case 'cash':
      case 'check':
        return await applyCashOrCheckPayment(recent, customerId, displayName, paymentStatus);
      case 'card':
        return await verifyCardPayment(recent, displayName, qb);
      case 'not_yet_paid':
        return await sendInvoiceNow(recent, displayName, customer);
    }
  } catch (err) {
    log.error('Payment branch threw', err as Error, { customerId, paymentStatus });
    return failure(
      `QuickBooks rejected the request: ${err instanceof Error ? err.message : String(err)}. Please contact Matt.`,
      true,
    );
  }
}

// ── Invoice selection ────────────────────────────────────────────────

function filterRecent(invoices: QBInvoice[]): QBInvoice[] {
  const cutoff = Date.now() - RECENT_INVOICE_WINDOW_MS;
  return invoices.filter((inv) => {
    // Prefer TxnDate (the invoice's business date); fall back to CreateTime.
    const dateStr = inv.TxnDate ?? inv.MetaData?.CreateTime;
    if (!dateStr) return false;
    const t = Date.parse(dateStr);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function mostRecent(invoices: QBInvoice[]): QBInvoice {
  return [...invoices].sort((a, b) => {
    const ad = Date.parse(a.TxnDate ?? a.MetaData?.CreateTime ?? '') || 0;
    const bd = Date.parse(b.TxnDate ?? b.MetaData?.CreateTime ?? '') || 0;
    return bd - ad;
  })[0];
}

function pickSingleOpen(
  invoices: QBInvoice[],
  displayName: string,
): { ok: true; invoice: QBInvoice } | { ok: false; failure: PaymentBranchFailure } {
  const open = invoices.filter((inv) => (inv.Balance ?? 0) > 0);
  if (open.length === 0) {
    return {
      ok: false,
      failure: failure(`No unpaid invoice found for ${displayName}. Please contact Matt.`, true),
    };
  }
  if (open.length > 1) {
    return {
      ok: false,
      failure: failure(
        `${open.length} unpaid invoices for ${displayName}. Please contact Matt to choose the right one.`,
        true,
      ),
    };
  }
  return { ok: true, invoice: open[0] };
}

// ── Branches ─────────────────────────────────────────────────────────

async function applyCashOrCheckPayment(
  invoices: QBInvoice[],
  customerId: string,
  displayName: string,
  status: 'cash' | 'check',
): Promise<PaymentBranchOutcome> {
  const picked = pickSingleOpen(invoices, displayName);
  if (!picked.ok) return picked.failure;
  const invoice = picked.invoice;

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

async function verifyCardPayment(
  invoices: QBInvoice[],
  displayName: string,
  qb: QuickBooksClient,
): Promise<PaymentBranchOutcome> {
  // Card path looks at the customer's MOST RECENT invoice (regardless of
  // balance). The right state is: balance == 0 AND paid by a credit-card method.
  const latest = mostRecent(invoices);

  // Always re-fetch to defeat any list-query staleness.
  const fresh = (await qb.getInvoice(latest.Id)) ?? latest;
  const balance = fresh.Balance ?? 0;

  if (balance > 0) {
    return failure(
      `Card payment hasn't posted yet — QuickBooks still shows invoice ${fresh.DocNumber ?? fresh.Id} unpaid ($${balance.toFixed(2)}). Matt will be notified.`,
      true,
    );
  }

  // Find the linked Payment(s) on the invoice
  const linkedPaymentIds = (fresh.LinkedTxn ?? [])
    .filter((t) => t.TxnType === 'Payment')
    .map((t) => t.TxnId);

  if (linkedPaymentIds.length === 0) {
    return failure(
      `Invoice ${fresh.DocNumber ?? fresh.Id} shows paid but no Payment link found in QuickBooks. Please contact Matt.`,
      true,
    );
  }

  const cardMethodIds = await getCardPaymentMethodIds(qb);

  for (const pid of linkedPaymentIds) {
    const pay = await qb.getPayment(pid);
    if (!pay) continue;
    const methodId = pay.PaymentMethodRef?.value;
    if (methodId && cardMethodIds.has(methodId)) {
      log.info('Verified card payment', { invoiceId: fresh.Id, paymentId: pid });
      return { ok: true, invoiceId: fresh.Id, paymentId: pid };
    }
  }

  return failure(
    `Invoice ${fresh.DocNumber ?? fresh.Id} for ${displayName} is paid, but not by credit card. If this was actually cash or check, please go back and pick the right option. Otherwise, contact Matt.`,
    true,
  );
}

async function sendInvoiceNow(
  invoices: QBInvoice[],
  displayName: string,
  customer: QBCustomer,
): Promise<PaymentBranchOutcome> {
  const picked = pickSingleOpen(invoices, displayName);
  if (!picked.ok) return picked.failure;
  const invoice = picked.invoice;

  // Idempotency: QB tracks EmailStatus on the invoice. If we've already
  // emailed it (Cron-A-era backlog, or Mike submitted twice), don't spam
  // the customer with a duplicate. Mark complete and move on.
  if (invoice.EmailStatus === 'EmailSent') {
    log.info('Invoice already sent — skipping resend', { invoiceId: invoice.Id });
    return { ok: true, invoiceId: invoice.Id, paymentId: null };
  }

  // Pick recipient: invoice BillEmail wins; fall back to customer's email.
  const recipient =
    invoice.BillEmail?.Address ?? customer.PrimaryEmailAddr?.Address;
  if (!recipient) {
    return failure(
      `${displayName} has no email on file in QuickBooks — can't email the invoice. Please contact Matt to add one, then re-submit.`,
      true,
    );
  }

  const qb = getQuickBooks();
  await qb.sendInvoice(invoice.Id, recipient);
  log.info('Sent invoice email', { invoiceId: invoice.Id, recipient });
  return { ok: true, invoiceId: invoice.Id, paymentId: null };
}

// ── Payment-method classification ────────────────────────────────────

/**
 * Which PaymentMethod entity IDs in this realm count as "credit card"?
 * Tries QBO's official Type === 'CREDIT_CARD' first; falls back to name
 * matching (handles custom methods named e.g. "Stripe" without Type set).
 */
async function getCardPaymentMethodIds(qb: QuickBooksClient): Promise<Set<string>> {
  const methods = await qb.listPaymentMethods();
  const ids = new Set<string>();
  for (const m of methods) {
    if (isCardMethod(m)) ids.add(m.Id);
  }
  return ids;
}

function isCardMethod(m: QBPaymentMethod): boolean {
  if (m.Type === 'CREDIT_CARD') return true;
  const name = (m.Name ?? '').toLowerCase();
  return (
    name.includes('card') ||
    name.includes('credit') ||
    name.includes('visa') ||
    name.includes('master') ||
    name.includes('amex') ||
    name.includes('discover') ||
    name.includes('stripe') ||
    name.includes('square')
  );
}

function failure(error: string, needsMattAttention: boolean): PaymentBranchFailure {
  return { ok: false, error, needsMattAttention };
}
