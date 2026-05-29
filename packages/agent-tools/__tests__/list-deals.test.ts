import { describe, it, expect, vi } from 'vitest';
import { listDeals } from '../src/list-deals.js';
import type { ToolDeps } from '../src/types.js';

function deal(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 't',
    personId: 10,
    organizationId: null,
    stageId: 5,
    stage: 'quote_sent',
    pipelineId: 1,
    value: 1000,
    currency: 'USD',
    status: 'open',
    qbEstimateId: null,
    qbInvoiceId: null,
    externalId: null,
    lostReason: null,
    addTime: '2026-05-15T00:00:00Z',
    updateTime: '2026-05-15T00:00:00Z',
    ...overrides,
  };
}

function makeDeps(overrides: {
  getDealsByPerson?: ReturnType<typeof vi.fn>;
  listDeals?: ReturnType<typeof vi.fn>;
} = {}): ToolDeps {
  return {
    pd: {
      getDealsByPerson: overrides.getDealsByPerson ?? vi.fn().mockResolvedValue([]),
      listDeals: overrides.listDeals ?? vi.fn().mockResolvedValue([]),
    } as never,
    qb: {} as never,
    quo: {} as never,
    cal: {} as never,
  };
}

describe('listDeals', () => {
  it('uses getDealsByPerson when personId is given', async () => {
    const getDealsByPerson = vi.fn().mockResolvedValue([deal({ id: 1 })]);
    const listDealsPd = vi.fn();
    const deps = makeDeps({ getDealsByPerson, listDeals: listDealsPd });

    const result = await listDeals(deps, { personId: 10 });

    expect(getDealsByPerson).toHaveBeenCalledWith(10);
    expect(listDealsPd).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('uses pd.listDeals when no personId', async () => {
    const listDealsPd = vi.fn().mockResolvedValue([deal({ id: 2 })]);
    const deps = makeDeps({ listDeals: listDealsPd });

    await listDeals(deps, { stage: 'quote_sent' });

    expect(listDealsPd).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'quote_sent' }),
    );
  });

  it('filters person-route results by stage client-side', async () => {
    const getDealsByPerson = vi.fn().mockResolvedValue([
      deal({ id: 1, stage: 'quote_sent' }),
      deal({ id: 2, stage: 'job_scheduled' }),
    ]);
    const deps = makeDeps({ getDealsByPerson });

    const result = await listDeals(deps, { personId: 10, stage: 'quote_sent' });

    expect(result.map((d) => d.id)).toEqual([1]);
  });

  it('filters by created-at range', async () => {
    const listDealsPd = vi.fn().mockResolvedValue([
      deal({ id: 1, addTime: '2026-04-01T00:00:00Z' }),
      deal({ id: 2, addTime: '2026-05-15T00:00:00Z' }),
      deal({ id: 3, addTime: '2026-06-10T00:00:00Z' }),
    ]);
    const deps = makeDeps({ listDeals: listDealsPd });

    const result = await listDeals(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
    });

    expect(result.map((d) => d.id)).toEqual([2]);
  });

  it('respects limit', async () => {
    const listDealsPd = vi.fn().mockResolvedValue([
      deal({ id: 1 }),
      deal({ id: 2 }),
      deal({ id: 3 }),
    ]);
    const deps = makeDeps({ listDeals: listDealsPd });

    const result = await listDeals(deps, { limit: 2 });

    expect(result).toHaveLength(2);
  });
});
