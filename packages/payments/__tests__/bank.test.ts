import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { getBankAccounts, getUndepositedPayments } from '../src/bank.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getUndepositedPayments', () => {
  it('lists Undeposited Funds payments not yet in a Deposit, newest first, with method names', async () => {
    const qb = {
      query: vi.fn().mockResolvedValue({
        QueryResponse: {
          Payment: [
            { Id: 'p1', TotalAmt: 675, TxnDate: '2026-11-01', CustomerRef: { value: 'c1', name: 'Jane Doe' }, PaymentMethodRef: { value: 'm-check' }, PaymentRefNum: '1042', DepositToAccountRef: { value: '8' } },
            { Id: 'p2', TotalAmt: 400, TxnDate: '2026-11-03', CustomerRef: { value: 'c2' }, DepositToAccountRef: { value: '8' } },
            { Id: 'p3', TotalAmt: 900, TxnDate: '2026-11-02', CustomerRef: { value: 'c3', name: 'Deposited' }, DepositToAccountRef: { value: '8' } },
            { Id: 'p4', TotalAmt: 100, TxnDate: '2026-11-04', CustomerRef: { value: 'c4', name: 'Card' }, DepositToAccountRef: { value: '35' } },
          ],
        },
      }),
      listRecentDeposits: vi.fn().mockResolvedValue([
        { Line: [{ LinkedTxn: [{ TxnId: 'p3', TxnType: 'Payment' }] }] },
      ]),
      listPaymentMethods: vi.fn().mockResolvedValue([{ Id: 'm-check', Name: 'Check' }]),
    };

    const out = await getUndepositedPayments(qb as unknown as QuickBooksClient);

    expect(qb.query).toHaveBeenCalledWith(
      "SELECT * FROM Payment WHERE TxnDate >= '2026-05-05' ORDER BY TxnDate DESC MAXRESULTS 500",
    );
    expect(qb.listRecentDeposits).toHaveBeenCalledWith(500);
    expect(out).toEqual([
      { id: 'p2', customerName: '(unknown customer)', amount: 400, date: '2026-11-03', method: 'Other', refNum: undefined },
      { id: 'p1', customerName: 'Jane Doe', amount: 675, date: '2026-11-01', method: 'Check', refNum: '1042' },
    ]);
  });

  it('returns an empty list when QuickBooks returns no payments', async () => {
    const qb = {
      query: vi.fn().mockResolvedValue({}),
      listRecentDeposits: vi.fn().mockResolvedValue([]),
      listPaymentMethods: vi.fn().mockResolvedValue([]),
    };
    await expect(getUndepositedPayments(qb as unknown as QuickBooksClient)).resolves.toEqual([]);
  });
});

describe('getBankAccounts', () => {
  it('lists Bank accounts by balance, highest first', async () => {
    const qb = {
      listAccounts: vi.fn().mockResolvedValue([
        { Id: 'a', CurrentBalance: 10 },
        { Id: 'b', CurrentBalance: 500 },
        { Id: 'c' },
      ]),
    };
    const out = await getBankAccounts(qb as unknown as QuickBooksClient);
    expect(qb.listAccounts).toHaveBeenCalledWith({ type: 'Bank' });
    expect(out.map((a) => a.Id)).toEqual(['b', 'a', 'c']);
  });
});
