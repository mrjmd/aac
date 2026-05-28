import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileDeals, estimateStatusToStage } from '../lib/deal-reconcile.js';
import type { PipedriveDeal } from '@aac/api-clients/pipedrive';
import type { QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';

const mockFindDealByExternalId = vi.fn();
const mockCreateDeal = vi.fn();
const mockSetDealStage = vi.fn();
const mockUpdateDeal = vi.fn();

const mockListRecentEstimates = vi.fn();
const mockListRecentInvoices = vi.fn();

const mockResolvePdPersonId = vi.fn();

function makeDeps() {
  return {
    pipedrive: {
      findDealByExternalId: mockFindDealByExternalId,
      createDeal: mockCreateDeal,
      setDealStage: mockSetDealStage,
      updateDeal: mockUpdateDeal,
    } as any,
    quickbooks: {
      listRecentEstimates: mockListRecentEstimates,
      listRecentInvoices: mockListRecentInvoices,
    } as any,
    resolvePdPersonId: mockResolvePdPersonId,
  };
}

function deal(overrides: Partial<PipedriveDeal>): PipedriveDeal {
  return {
    id: 1,
    title: 'd',
    personId: 100,
    organizationId: null,
    stageId: 5,
    stage: 'quote_sent',
    pipelineId: 1,
    value: null,
    currency: null,
    status: 'open',
    qbEstimateId: null,
    qbInvoiceId: null,
    externalId: null,
    lostReason: null,
    addTime: '2026-05-01 12:00:00',
    updateTime: '2026-05-01 12:00:00',
    ...overrides,
  };
}

function estimate(overrides: Partial<QBEstimate>): QBEstimate {
  return {
    Id: 'est-1',
    SyncToken: '0',
    DocNumber: '1001',
    TxnStatus: 'Pending',
    CustomerRef: { value: 'qb-cust-1' },
    Line: [],
    ...overrides,
  };
}

function invoice(overrides: Partial<QBInvoice>): QBInvoice {
  return {
    Id: 'inv-1',
    SyncToken: '0',
    DocNumber: '2001',
    CustomerRef: { value: 'qb-cust-1' },
    Line: [],
    Balance: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListRecentEstimates.mockResolvedValue([]);
  mockListRecentInvoices.mockResolvedValue([]);
});

describe('estimateStatusToStage', () => {
  it('maps Pending and undefined to quote_sent', () => {
    expect(estimateStatusToStage('Pending')).toBe('quote_sent');
    expect(estimateStatusToStage(undefined)).toBe('quote_sent');
  });

  it('maps Accepted and Converted to quote_accepted', () => {
    expect(estimateStatusToStage('Accepted')).toBe('quote_accepted');
    expect(estimateStatusToStage('Converted')).toBe('quote_accepted');
  });

  it('returns null for terminal statuses (Rejected, Closed)', () => {
    expect(estimateStatusToStage('Rejected')).toBeNull();
    expect(estimateStatusToStage('Closed')).toBeNull();
  });
});

describe('reconcileDeals — estimates phase', () => {
  it('creates a quote_sent deal for a Pending estimate with no existing deal', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ Id: 'est-1', DocNumber: '1001', TxnStatus: 'Pending' }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue('5334');
    mockCreateDeal.mockResolvedValue(deal({ id: 999 }));

    const summary = await reconcileDeals(makeDeps());

    expect(summary.estimates.dealsCreated).toBe(1);
    expect(mockCreateDeal).toHaveBeenCalledWith({
      title: 'Quote 1001',
      personId: 5334,
      stage: 'quote_sent',
      qbEstimateId: 'est-1',
      externalId: 'qb-est-est-1',
    });
  });

  it('creates a quote_accepted deal for an Accepted estimate with no existing deal', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ TxnStatus: 'Accepted' }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue('5334');
    mockCreateDeal.mockResolvedValue(deal({ id: 999 }));

    await reconcileDeals(makeDeps());

    expect(mockCreateDeal).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'quote_accepted' }),
    );
  });

  it('advances stage when QB shows the deal further along', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ TxnStatus: 'Accepted' }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(deal({ id: 42, stage: 'quote_sent' }));

    const summary = await reconcileDeals(makeDeps());

    expect(summary.estimates.stagesAdvanced).toBe(1);
    expect(mockSetDealStage).toHaveBeenCalledWith(42, 'quote_accepted');
  });

  it('does not demote a deal already past quote_accepted', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ TxnStatus: 'Accepted' }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(deal({ id: 42, stage: 'job_scheduled' }));

    const summary = await reconcileDeals(makeDeps());

    expect(summary.estimates.stagesAdvanced).toBe(0);
    expect(mockSetDealStage).not.toHaveBeenCalled();
  });

  it('skips Rejected estimates without creating or modifying anything', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ TxnStatus: 'Rejected' }),
    ]);

    const summary = await reconcileDeals(makeDeps());

    expect(summary.estimates.skippedTerminal).toBe(1);
    expect(mockFindDealByExternalId).not.toHaveBeenCalled();
    expect(mockCreateDeal).not.toHaveBeenCalled();
  });

  it('skips estimates with no PD mapping', async () => {
    mockListRecentEstimates.mockResolvedValue([estimate({})]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue(null);

    const summary = await reconcileDeals(makeDeps());

    expect(summary.estimates.skippedNoMapping).toBe(1);
    expect(mockCreateDeal).not.toHaveBeenCalled();
  });

  it('does not touch Lost deals', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ TxnStatus: 'Accepted' }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(deal({ id: 42, stage: 'lost' }));

    await reconcileDeals(makeDeps());

    expect(mockSetDealStage).not.toHaveBeenCalled();
  });
});

describe('reconcileDeals — invoices phase', () => {
  it('advances a deal to Paid when invoice balance is zero', async () => {
    mockListRecentInvoices.mockResolvedValue([invoice({ Balance: 0 })]);
    mockFindDealByExternalId.mockResolvedValue(
      deal({ id: 42, stage: 'job_done', qbInvoiceId: 'inv-1' }),
    );

    const summary = await reconcileDeals(makeDeps());

    expect(summary.invoices.stagesAdvanced).toBe(1);
    expect(mockSetDealStage).toHaveBeenCalledWith(42, 'paid');
  });

  it('does not advance to Paid when balance is positive', async () => {
    mockListRecentInvoices.mockResolvedValue([invoice({ Balance: 250 })]);
    mockFindDealByExternalId.mockResolvedValue(
      deal({ id: 42, stage: 'job_done', qbInvoiceId: 'inv-1' }),
    );

    const summary = await reconcileDeals(makeDeps());

    expect(summary.invoices.stagesAdvanced).toBe(0);
    expect(mockSetDealStage).not.toHaveBeenCalled();
  });

  it('falls back to linked-estimate lookup when no direct deal exists', async () => {
    mockListRecentInvoices.mockResolvedValue([
      invoice({
        Id: 'inv-9',
        Balance: 0,
        LinkedTxn: [{ TxnType: 'Estimate', TxnId: 'est-7' }],
      }),
    ]);
    mockFindDealByExternalId
      .mockResolvedValueOnce(null) // qb-inv-inv-9 lookup
      .mockResolvedValueOnce(deal({ id: 77, stage: 'quote_accepted', qbInvoiceId: null }));

    const summary = await reconcileDeals(makeDeps());

    expect(mockFindDealByExternalId).toHaveBeenNthCalledWith(1, 'qb-inv-inv-9');
    expect(mockFindDealByExternalId).toHaveBeenNthCalledWith(2, 'qb-est-est-7');
    expect(summary.invoices.invoicesLinked).toBe(1);
    expect(mockUpdateDeal).toHaveBeenCalledWith(77, { qbInvoiceId: 'inv-9' });
    expect(mockSetDealStage).toHaveBeenCalledWith(77, 'paid');
  });

  it('creates an orphan invoice deal when no estimate or existing deal is linked', async () => {
    mockListRecentInvoices.mockResolvedValue([
      invoice({ Id: 'inv-x', DocNumber: '5000', Balance: 0 }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue('5334');
    mockCreateDeal.mockResolvedValue(deal({ id: 88 }));

    const summary = await reconcileDeals(makeDeps());

    expect(summary.invoices.dealsCreated).toBe(1);
    expect(mockCreateDeal).toHaveBeenCalledWith({
      title: 'Invoice 5000',
      personId: 5334,
      stage: 'paid',
      qbInvoiceId: 'inv-x',
      externalId: 'qb-inv-inv-x',
    });
  });

  it('creates an unpaid invoice deal at job_done when balance > 0 and no deal exists', async () => {
    mockListRecentInvoices.mockResolvedValue([
      invoice({ Id: 'inv-y', Balance: 800 }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue('5334');
    mockCreateDeal.mockResolvedValue(deal({ id: 89 }));

    await reconcileDeals(makeDeps());

    expect(mockCreateDeal).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'job_done' }),
    );
  });

  it('stamps qb_invoice_id when missing without advancing stage unnecessarily', async () => {
    mockListRecentInvoices.mockResolvedValue([invoice({ Balance: 500 })]);
    mockFindDealByExternalId.mockResolvedValue(
      deal({ id: 42, stage: 'quote_accepted', qbInvoiceId: null }),
    );

    const summary = await reconcileDeals(makeDeps());

    expect(summary.invoices.invoicesLinked).toBe(1);
    expect(mockUpdateDeal).toHaveBeenCalledWith(42, { qbInvoiceId: 'inv-1' });
    expect(mockSetDealStage).not.toHaveBeenCalled();
  });
});

describe('reconcileDeals — full pass', () => {
  it('returns a summary aggregating both phases', async () => {
    mockListRecentEstimates.mockResolvedValue([
      estimate({ Id: 'est-a', TxnStatus: 'Pending' }),
      estimate({ Id: 'est-b', TxnStatus: 'Rejected' }),
    ]);
    mockListRecentInvoices.mockResolvedValue([
      invoice({ Id: 'inv-a', Balance: 0 }),
    ]);
    mockFindDealByExternalId.mockResolvedValue(null);
    mockResolvePdPersonId.mockResolvedValue('5334');
    mockCreateDeal.mockResolvedValue(deal({ id: 1 }));

    const summary = await reconcileDeals(makeDeps());

    expect(summary).toEqual({
      estimates: {
        scanned: 2,
        dealsCreated: 1,
        stagesAdvanced: 0,
        skippedNoMapping: 0,
        skippedTerminal: 1,
      },
      invoices: {
        scanned: 1,
        dealsCreated: 1,
        stagesAdvanced: 0,
        invoicesLinked: 0,
        skippedNoMapping: 0,
      },
    });
  });
});
