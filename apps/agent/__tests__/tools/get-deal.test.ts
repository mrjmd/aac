import { describe, it, expect, vi } from 'vitest';
import { getDeal } from '../../lib/tools/get-deal.js';
import type { ToolDeps } from '../../lib/tools/types.js';

const CONFIG = { pdCompanyDomain: 'attackacrack' };

const DEAL = {
  id: 100,
  title: 'Foundation',
  personId: 42,
  organizationId: null,
  stageId: 7,
  stage: 'job_scheduled' as const,
  pipelineId: 1,
  value: 5200,
  currency: 'USD',
  status: 'open' as const,
  qbEstimateId: 'qbe-1',
  qbInvoiceId: null,
  externalId: 'qb-est-qbe-1',
  lostReason: null,
  addTime: '2026-05-01',
  updateTime: '2026-05-20',
};

const PERSON = {
  id: 42,
  name: 'Jane Davis',
  phone: [{ value: '+16175551111', primary: true }],
  email: [],
  org_id: undefined,
};

const ESTIMATE = {
  Id: 'qbe-1',
  SyncToken: '0',
  DocNumber: '1234',
  TxnStatus: 'Accepted' as const,
  TxnDate: '2026-05-02',
  TotalAmt: 5200,
  CustomerRef: { value: 'cust-1', name: 'Jane Davis' },
  Line: [],
  LinkedTxn: [],
};

function makeDeps(overrides: {
  getDeal?: ReturnType<typeof vi.fn>;
  getPerson?: ReturnType<typeof vi.fn>;
  getEstimate?: ReturnType<typeof vi.fn>;
  getInvoice?: ReturnType<typeof vi.fn>;
  listEvents?: ReturnType<typeof vi.fn>;
} = {}): ToolDeps {
  return {
    pd: {
      getDeal: overrides.getDeal ?? vi.fn().mockResolvedValue(DEAL),
      getPerson: overrides.getPerson ?? vi.fn().mockResolvedValue(PERSON),
    } as never,
    qb: {
      getEstimate: overrides.getEstimate ?? vi.fn().mockResolvedValue(ESTIMATE),
      getInvoice: overrides.getInvoice ?? vi.fn().mockResolvedValue(null),
    } as never,
    quo: {} as never,
    cal: {
      listEvents: overrides.listEvents ?? vi.fn().mockResolvedValue([]),
    } as never,
  };
}

describe('getDeal', () => {
  it('returns nulls when the deal is not found', async () => {
    const deps = makeDeps({ getDeal: vi.fn().mockResolvedValue(null) });
    const result = await getDeal(deps, CONFIG, { dealId: 999 });
    expect(result).toEqual({
      deal: null,
      person: null,
      estimate: null,
      invoice: null,
      events: [],
    });
  });

  it('returns deal, person, and estimate summaries when all are present', async () => {
    const deps = makeDeps();
    const result = await getDeal(deps, CONFIG, { dealId: 100 });

    expect(result.deal?.id).toBe(100);
    expect(result.person?.id).toBe(42);
    expect(result.estimate?.id).toBe('qbe-1');
    expect(result.invoice).toBeNull();
  });

  it('skips QB lookups when the deal has no qb_*_id', async () => {
    const getEstimate = vi.fn();
    const getInvoice = vi.fn();
    const deps = makeDeps({
      getDeal: vi.fn().mockResolvedValue({
        ...DEAL,
        qbEstimateId: null,
        qbInvoiceId: null,
      }),
      getEstimate,
      getInvoice,
    });

    await getDeal(deps, CONFIG, { dealId: 100 });

    expect(getEstimate).not.toHaveBeenCalled();
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it('includes only calendar events whose [deal:N] marker matches', async () => {
    const deps = makeDeps({
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt-a',
          summary: 'Davis',
          description: '[deal:100]',
          start: 's',
          end: 'e',
          attendees: [],
          htmlLink: '',
          attachments: [],
        },
        {
          id: 'evt-b',
          summary: 'Smith',
          description: '[deal:101]',
          start: 's',
          end: 'e',
          attendees: [],
          htmlLink: '',
          attachments: [],
        },
        {
          id: 'evt-c',
          summary: 'No marker',
          description: 'just notes',
          start: 's',
          end: 'e',
          attendees: [],
          htmlLink: '',
          attachments: [],
        },
      ]),
    });

    const result = await getDeal(deps, CONFIG, { dealId: 100 });

    expect(result.events.map((e) => e.id)).toEqual(['evt-a']);
    expect(result.events[0].dealId).toBe(100);
  });
});
