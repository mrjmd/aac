import { describe, it, expect, vi } from 'vitest';
import { getInvoiceSummary } from '../../lib/tools/get-invoice-summary.js';
import type { ToolDeps } from '../../lib/tools/types.js';

function inv(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'inv',
    SyncToken: '0',
    TxnDate: '2026-05-10',
    TotalAmt: 1000,
    Balance: 0,
    CustomerRef: { value: 'c1', name: 'Jane' },
    Line: [],
    MetaData: { CreateTime: '2026-05-10T10:00:00Z' },
    ...overrides,
  };
}

function makeDeps(invoices: unknown[]): ToolDeps {
  return {
    pd: {} as never,
    qb: { listRecentInvoices: vi.fn().mockResolvedValue(invoices) } as never,
    quo: {} as never,
    cal: {} as never,
  };
}

describe('getInvoiceSummary', () => {
  it('defaults rangeStart to first of current UTC month and rangeEnd to now', async () => {
    const listRecentInvoices = vi.fn().mockResolvedValue([]);
    const deps: ToolDeps = {
      pd: {} as never,
      qb: { listRecentInvoices } as never,
      quo: {} as never,
      cal: {} as never,
    };

    const result = await getInvoiceSummary(deps, {});

    expect(listRecentInvoices).toHaveBeenCalledOnce();
    const arg = listRecentInvoices.mock.calls[0][0] as string;
    expect(arg.endsWith('-01T00:00:00.000Z')).toBe(true);
    expect(Date.parse(result.rangeEnd)).toBeGreaterThan(Date.parse(result.rangeStart));
  });

  it('aggregates total / paid / unpaid across invoices', async () => {
    const deps = makeDeps([
      inv({ Id: '1', TotalAmt: 1000, Balance: 0 }),
      inv({ Id: '2', TotalAmt: 800, Balance: 200, CustomerRef: { value: 'c2', name: 'Bob' } }),
      inv({ Id: '3', TotalAmt: 500, Balance: 500, CustomerRef: { value: 'c1', name: 'Jane' } }),
    ]);

    const result = await getInvoiceSummary(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
    });

    expect(result.totalCount).toBe(3);
    expect(result.totalAmount).toBe(2300);
    expect(result.paidAmount).toBe(1600);
    expect(result.unpaidAmount).toBe(700);
  });

  it('groups by customer and sorts by amount desc', async () => {
    const deps = makeDeps([
      inv({ Id: '1', TotalAmt: 500, CustomerRef: { value: 'c1', name: 'Jane' } }),
      inv({ Id: '2', TotalAmt: 2000, CustomerRef: { value: 'c2', name: 'Bob' } }),
      inv({ Id: '3', TotalAmt: 100, CustomerRef: { value: 'c1', name: 'Jane' } }),
    ]);

    const result = await getInvoiceSummary(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
    });

    expect(result.byCustomer.map((c) => c.customerName)).toEqual(['Bob', 'Jane']);
    expect(result.byCustomer[1].count).toBe(2);
    expect(result.byCustomer[1].amount).toBe(600);
  });

  it('excludes invoices outside the date range', async () => {
    const deps = makeDeps([
      inv({ MetaData: { CreateTime: '2026-04-30T00:00:00Z' } }),
      inv({ MetaData: { CreateTime: '2026-05-15T00:00:00Z' } }),
      inv({ MetaData: { CreateTime: '2026-06-02T00:00:00Z' } }),
    ]);

    const result = await getInvoiceSummary(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T23:59:59Z',
    });

    expect(result.totalCount).toBe(1);
  });

  it('falls back to TxnDate when MetaData.CreateTime is missing', async () => {
    const deps = makeDeps([
      inv({ TxnDate: '2026-05-10', MetaData: undefined }),
    ]);

    const result = await getInvoiceSummary(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
    });

    expect(result.totalCount).toBe(1);
  });
});
