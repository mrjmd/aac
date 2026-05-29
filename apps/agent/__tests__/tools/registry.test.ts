import { describe, it, expect, vi } from 'vitest';
import { buildToolRegistry } from '../../lib/tools/index.js';
import type { ToolDeps } from '../../lib/tools/types.js';

const CONFIG = { pdCompanyDomain: 'attackacrack' };

function emptyDeps(): ToolDeps {
  return {
    pd: {
      getPerson: vi.fn().mockResolvedValue(null),
      searchPersonByPhone: vi.fn().mockResolvedValue(null),
      getDealsByPerson: vi.fn().mockResolvedValue([]),
      listDeals: vi.fn().mockResolvedValue([]),
      getDeal: vi.fn().mockResolvedValue(null),
    } as never,
    qb: {
      getEstimate: vi.fn(),
      getInvoice: vi.fn(),
      listRecentInvoices: vi.fn().mockResolvedValue([]),
    } as never,
    quo: {
      getRecentActivityForContact: vi.fn().mockResolvedValue({ messages: [], calls: [] }),
      listMessages: vi.fn().mockResolvedValue({ data: [] }),
    } as never,
    cal: { listEvents: vi.fn().mockResolvedValue([]) } as never,
  };
}

describe('buildToolRegistry', () => {
  it('returns all seven owner tools for role=owner', () => {
    const tools = buildToolRegistry('owner', emptyDeps(), CONFIG);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'findJobsMissingInvoices',
        'getCustomerContext',
        'getDeal',
        'getInvoiceSummary',
        'listDeals',
        'searchCalendar',
        'searchConversation',
      ].sort(),
    );
  });

  it('returns empty registries for non-owner roles', () => {
    expect(buildToolRegistry('technician', emptyDeps(), CONFIG)).toEqual([]);
    expect(buildToolRegistry('salesperson', emptyDeps(), CONFIG)).toEqual([]);
    expect(buildToolRegistry('triage', emptyDeps(), CONFIG)).toEqual([]);
  });

  it('every owner tool has name, description, inputSchema, invoke', () => {
    const tools = buildToolRegistry('owner', emptyDeps(), CONFIG);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toBeTypeOf('object');
      expect(t.invoke).toBeTypeOf('function');
    }
  });

  it('invoke wires arguments through to the underlying tool function', async () => {
    const deps = emptyDeps();
    const tools = buildToolRegistry('owner', deps, CONFIG);
    const listDealsTool = tools.find((t) => t.name === 'listDeals')!;

    await listDealsTool.invoke({ stage: 'quote_sent' });

    expect(deps.pd.listDeals).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'quote_sent' }),
    );
  });
});
