import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type {
  QBInvoice,
  QBPaymentMethod,
  QuickBooksClient,
} from '@aac/api-clients/quickbooks';

const { matchEventToPerson, matchPersonToQBCustomer } = vi.hoisted(() => ({
  matchEventToPerson: vi.fn(),
  matchPersonToQBCustomer: vi.fn(),
}));
vi.mock('@aac/customers', () => ({ matchEventToPerson, matchPersonToQBCustomer }));

import { executePaymentBranch } from '../src/payment-branches.js';

const NOW = new Date('2026-11-05T15:00:00Z');
const EVENT = { id: 'evt-1', summary: 'Jane Doe — crack injection' } as unknown as CalendarEvent;
const PERSON = { id: 9, name: 'Jane Doe' };
const CUSTOMER = {
  Id: 'qb-1',
  DisplayName: 'Jane Doe',
  PrimaryEmailAddr: { Address: 'jane@example.com' },
};

const METHODS: QBPaymentMethod[] = [
  { Id: 'm-cash', Name: 'Cash' },
  { Id: 'm-check', Name: 'Check' },
  { Id: 'm-visa', Name: 'Visa', Type: 'CREDIT_CARD' },
  { Id: 'm-stripe', Name: 'Stripe' },
];

function invoice(over: Partial<QBInvoice> = {}): QBInvoice {
  return {
    Id: 'inv-1',
    SyncToken: '0',
    DocNumber: '1001',
    TxnDate: '2026-11-04',
    CustomerRef: { value: 'qb-1' },
    Line: [],
    TotalAmt: 675,
    Balance: 675,
    ...over,
  };
}

function makeQb(invoices: QBInvoice[], methods: QBPaymentMethod[] = METHODS) {
  return {
    getInvoicesByCustomer: vi.fn().mockResolvedValue(invoices),
    listPaymentMethods: vi.fn().mockResolvedValue(methods),
    createPaymentForInvoice: vi.fn().mockResolvedValue({ Id: 'pay-new' }),
    getInvoice: vi.fn(),
    getPayment: vi.fn(),
    sendInvoice: vi.fn().mockResolvedValue(undefined),
  };
}

function run(qb: ReturnType<typeof makeQb>, status: Parameters<typeof executePaymentBranch>[2]) {
  return executePaymentBranch(
    { pd: {} as PipedriveClient, qb: qb as unknown as QuickBooksClient },
    EVENT,
    status,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  matchEventToPerson.mockResolvedValue(PERSON);
  matchPersonToQBCustomer.mockResolvedValue(CUSTOMER);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('matching', () => {
  it('fails for Matt when the event matches no Pipedrive person', async () => {
    matchEventToPerson.mockResolvedValueOnce(null);
    await expect(run(makeQb([]), 'cash')).resolves.toEqual({
      ok: false,
      error: "Couldn't match this job to a Pipedrive person. Please contact Matt.",
      needsMattAttention: true,
    });
  });

  it('fails when the person has no QuickBooks customer', async () => {
    matchPersonToQBCustomer.mockResolvedValueOnce(null);
    await expect(run(makeQb([]), 'cash')).resolves.toMatchObject({
      ok: false,
      error: "Couldn't find a QuickBooks customer for Jane Doe. Please contact Matt.",
    });
  });

  it('ignores invoices older than 14 days', async () => {
    const qb = makeQb([invoice({ TxnDate: '2026-10-20' })]);
    await expect(run(qb, 'cash')).resolves.toMatchObject({
      ok: false,
      error: 'No recent invoice found for Jane Doe. Please contact Matt.',
    });
  });

  it('falls back to MetaData.CreateTime when TxnDate is missing', async () => {
    const qb = makeQb([invoice({ TxnDate: undefined, MetaData: { CreateTime: '2026-11-03T12:00:00Z' } })]);
    await expect(run(qb, 'cash')).resolves.toMatchObject({ ok: true, invoiceId: 'inv-1' });
  });
});

describe('cash / check', () => {
  it('records a payment for the full balance with the matching method', async () => {
    const qb = makeQb([invoice({ Balance: 500 })]);
    await expect(run(qb, 'check')).resolves.toEqual({ ok: true, invoiceId: 'inv-1', paymentId: 'pay-new' });
    expect(qb.createPaymentForInvoice).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      customerId: 'qb-1',
      amount: 500,
      paymentMethodId: 'm-check',
    });
  });

  it('refuses to pick between several open invoices', async () => {
    const qb = makeQb([invoice(), invoice({ Id: 'inv-2' })]);
    await expect(run(qb, 'cash')).resolves.toMatchObject({
      ok: false,
      error: '2 unpaid invoices for Jane Doe. Please contact Matt to choose the right one.',
    });
    expect(qb.createPaymentForInvoice).not.toHaveBeenCalled();
  });

  it('fails when no invoice is open', async () => {
    const qb = makeQb([invoice({ Balance: 0 })]);
    await expect(run(qb, 'cash')).resolves.toMatchObject({
      ok: false,
      error: 'No unpaid invoice found for Jane Doe. Please contact Matt.',
    });
  });

  it('fails when QuickBooks has no such payment method', async () => {
    const qb = makeQb([invoice()], [{ Id: 'm-visa', Name: 'Visa' }]);
    await expect(run(qb, 'cash')).resolves.toMatchObject({
      ok: false,
      error: 'QuickBooks doesn\'t have a "cash" payment method configured. Please contact Matt.',
    });
  });

  it('turns a QuickBooks error into a structured failure', async () => {
    const qb = makeQb([invoice()]);
    qb.createPaymentForInvoice.mockRejectedValueOnce(new Error('QB 500'));
    await expect(run(qb, 'cash')).resolves.toEqual({
      ok: false,
      error: 'QuickBooks rejected the request: QB 500. Please contact Matt.',
      needsMattAttention: true,
    });
  });
});

describe('card', () => {
  it('verifies the most recent invoice was paid by a card method (Type CREDIT_CARD)', async () => {
    const latest = invoice({ Id: 'inv-2', TxnDate: '2026-11-05', Balance: 0 });
    const qb = makeQb([invoice({ TxnDate: '2026-11-01' }), latest]);
    qb.getInvoice.mockResolvedValueOnce({
      ...latest,
      LinkedTxn: [{ TxnId: 'pay-1', TxnType: 'Payment' }],
    });
    qb.getPayment.mockResolvedValueOnce({ Id: 'pay-1', PaymentMethodRef: { value: 'm-visa' } });
    await expect(run(qb, 'card')).resolves.toEqual({ ok: true, invoiceId: 'inv-2', paymentId: 'pay-1' });
    expect(qb.getInvoice).toHaveBeenCalledWith('inv-2');
  });

  it('accepts a card method recognized by name (Stripe)', async () => {
    const qb = makeQb([invoice({ Balance: 0 })]);
    qb.getInvoice.mockResolvedValueOnce({ ...invoice({ Balance: 0 }), LinkedTxn: [{ TxnId: 'pay-1', TxnType: 'Payment' }] });
    qb.getPayment.mockResolvedValueOnce({ Id: 'pay-1', PaymentMethodRef: { value: 'm-stripe' } });
    await expect(run(qb, 'card')).resolves.toMatchObject({ ok: true, paymentId: 'pay-1' });
  });

  it('blocks when the invoice is still unpaid', async () => {
    const qb = makeQb([invoice({ Balance: 675 })]);
    qb.getInvoice.mockResolvedValueOnce(invoice({ Balance: 675 }));
    await expect(run(qb, 'card')).resolves.toMatchObject({
      ok: false,
      error:
        "Card payment hasn't posted yet — QuickBooks still shows invoice 1001 unpaid ($675.00). Matt will be notified.",
    });
  });

  it('blocks when paid but with no linked Payment', async () => {
    const qb = makeQb([invoice({ Balance: 0 })]);
    qb.getInvoice.mockResolvedValueOnce(null);
    await expect(run(qb, 'card')).resolves.toMatchObject({
      ok: false,
      error: 'Invoice 1001 shows paid but no Payment link found in QuickBooks. Please contact Matt.',
    });
  });

  it('blocks when paid by cash (wrong button)', async () => {
    const qb = makeQb([invoice({ Balance: 0 })]);
    qb.getInvoice.mockResolvedValueOnce({ ...invoice({ Balance: 0 }), LinkedTxn: [{ TxnId: 'pay-1', TxnType: 'Payment' }] });
    qb.getPayment.mockResolvedValueOnce({ Id: 'pay-1', PaymentMethodRef: { value: 'm-cash' } });
    await expect(run(qb, 'card')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('is paid, but not by credit card'),
    });
  });
});

describe('not yet paid', () => {
  it('emails the open invoice to its BillEmail', async () => {
    const qb = makeQb([invoice({ BillEmail: { Address: 'billing@example.com' } })]);
    await expect(run(qb, 'not_yet_paid')).resolves.toEqual({ ok: true, invoiceId: 'inv-1', paymentId: null });
    expect(qb.sendInvoice).toHaveBeenCalledWith('inv-1', 'billing@example.com');
  });

  it("falls back to the customer's email", async () => {
    const qb = makeQb([invoice()]);
    await run(qb, 'not_yet_paid');
    expect(qb.sendInvoice).toHaveBeenCalledWith('inv-1', 'jane@example.com');
  });

  it('does not resend an invoice already emailed', async () => {
    const qb = makeQb([invoice({ EmailStatus: 'EmailSent' })]);
    await expect(run(qb, 'not_yet_paid')).resolves.toMatchObject({ ok: true, invoiceId: 'inv-1' });
    expect(qb.sendInvoice).not.toHaveBeenCalled();
  });

  it('fails when there is no email on file', async () => {
    matchPersonToQBCustomer.mockResolvedValueOnce({ Id: 'qb-1', DisplayName: 'Jane Doe' });
    const qb = makeQb([invoice()]);
    await expect(run(qb, 'not_yet_paid')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('has no email on file in QuickBooks'),
    });
    expect(qb.sendInvoice).not.toHaveBeenCalled();
  });
});
