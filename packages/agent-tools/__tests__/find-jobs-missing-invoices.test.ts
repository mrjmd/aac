import { describe, it, expect, vi } from 'vitest';
import { findJobsMissingInvoices } from '../src/find-jobs-missing-invoices.js';
import type { ToolDeps } from '../src/types.js';

const CONFIG = { pdCompanyDomain: 'attackacrack' };

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt',
    summary: 'job',
    description: '',
    start: '2026-05-15T13:00:00Z',
    end: '2026-05-15T16:00:00Z',
    colorId: '10',
    attendees: [],
    htmlLink: '',
    attachments: [],
    ...overrides,
  };
}

function deal(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    title: 't',
    personId: 42,
    organizationId: null,
    stageId: 8,
    stage: 'job_done',
    pipelineId: 1,
    value: 5000,
    currency: 'USD',
    status: 'open',
    qbEstimateId: 'e-1',
    qbInvoiceId: null,
    externalId: null,
    lostReason: null,
    addTime: '',
    updateTime: '',
    ...overrides,
  };
}

function person() {
  return { id: 42, name: 'Jane Davis', phone: [], email: [] };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'inv-1',
    SyncToken: '0',
    CustomerRef: { value: 'c', name: 'Jane' },
    Line: [],
    LinkedTxn: [],
    Balance: 0,
    ...overrides,
  };
}

function makeDeps(overrides: {
  listEvents?: ReturnType<typeof vi.fn>;
  getDeal?: ReturnType<typeof vi.fn>;
  getPerson?: ReturnType<typeof vi.fn>;
  getInvoice?: ReturnType<typeof vi.fn>;
} = {}): ToolDeps {
  return {
    pd: {
      getDeal: overrides.getDeal ?? vi.fn().mockResolvedValue(null),
      getPerson: overrides.getPerson ?? vi.fn().mockResolvedValue(null),
    } as never,
    qb: {
      getInvoice: overrides.getInvoice ?? vi.fn().mockResolvedValue(null),
    } as never,
    quo: {} as never,
    cal: {
      listEvents: overrides.listEvents ?? vi.fn().mockResolvedValue([]),
    } as never,
  };
}

describe('findJobsMissingInvoices', () => {
  it('only queries green (color 10) events from calendar', async () => {
    const listEvents = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ listEvents });

    await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
    });

    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ colorIds: ['10'] }),
    );
  });

  it('reports no_deal_link when event description has no marker', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([event({ description: 'just notes' })]),
    });

    const result = await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });

    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('no_deal_link');
    expect(result[0].matchedDeal).toBeNull();
  });

  it('reports no_deal_link when marker is present but deal is gone', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([event({ description: '[deal:999]' })]),
      getDeal: vi.fn().mockResolvedValue(null),
    });

    const result = await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });

    expect(result[0].reason).toBe('no_deal_link');
  });

  it('reports deal_has_no_invoice when deal exists but qbInvoiceId is empty', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([event({ description: '[deal:100]' })]),
      getDeal: vi.fn().mockResolvedValue(deal({ qbInvoiceId: null })),
      getPerson: vi.fn().mockResolvedValue(person()),
    });

    const result = await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });

    expect(result[0].reason).toBe('deal_has_no_invoice');
    expect(result[0].matchedDeal?.id).toBe(100);
    expect(result[0].matchedPerson?.id).toBe(42);
  });

  it('reports invoice_not_found_in_qb when qbInvoiceId points to nothing', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([event({ description: '[deal:100]' })]),
      getDeal: vi.fn().mockResolvedValue(deal({ qbInvoiceId: 'inv-missing' })),
      getPerson: vi.fn().mockResolvedValue(person()),
      getInvoice: vi.fn().mockResolvedValue(null),
    });

    const result = await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });

    expect(result[0].reason).toBe('invoice_not_found_in_qb');
  });

  it('omits events where the deal has a valid invoice', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([event({ description: '[deal:100]' })]),
      getDeal: vi.fn().mockResolvedValue(deal({ qbInvoiceId: 'inv-1' })),
      getPerson: vi.fn().mockResolvedValue(person()),
      getInvoice: vi.fn().mockResolvedValue(invoice()),
    });

    const result = await findJobsMissingInvoices(deps, CONFIG, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });

    expect(result).toEqual([]);
  });
});
