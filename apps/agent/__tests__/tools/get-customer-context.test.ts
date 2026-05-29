import { describe, it, expect, vi } from 'vitest';
import { getCustomerContext } from '../../lib/tools/get-customer-context.js';
import type { ToolDeps } from '../../lib/tools/types.js';

const CONFIG = { pdCompanyDomain: 'attackacrack' };

function makeDeps(overrides: {
  getPerson?: typeof vi.fn;
  searchPersonByPhone?: typeof vi.fn;
  getDealsByPerson?: typeof vi.fn;
  listEvents?: typeof vi.fn;
  getRecentActivityForContact?: typeof vi.fn;
} = {}): ToolDeps {
  return {
    pd: {
      getPerson: overrides.getPerson ?? vi.fn().mockResolvedValue(null),
      searchPersonByPhone: overrides.searchPersonByPhone ?? vi.fn().mockResolvedValue(null),
      getDealsByPerson: overrides.getDealsByPerson ?? vi.fn().mockResolvedValue([]),
    } as never,
    qb: {} as never,
    quo: {
      getRecentActivityForContact:
        overrides.getRecentActivityForContact ??
        vi.fn().mockResolvedValue({ messages: [], calls: [] }),
    } as never,
    cal: {
      listEvents: overrides.listEvents ?? vi.fn().mockResolvedValue([]),
    } as never,
  };
}

const SAMPLE_PERSON = {
  id: 42,
  name: 'Jane Davis',
  phone: [{ value: '+16175551111', primary: true }],
  email: [{ value: 'jane@example.com', primary: true }],
  org_id: 7,
};

describe('getCustomerContext', () => {
  it('returns empty payload when neither personId nor phone resolves', async () => {
    const deps = makeDeps();
    const result = await getCustomerContext(deps, CONFIG, { personId: 999 });

    expect(result.person).toBeNull();
    expect(result.deals).toEqual([]);
    expect(result.recentMessages).toEqual([]);
    expect(result.recentCalls).toEqual([]);
    expect(result.recentEvents).toEqual([]);
  });

  it('throws when input has neither personId nor phone', async () => {
    const deps = makeDeps();
    await expect(getCustomerContext(deps, CONFIG, {})).rejects.toThrow(
      /personId or phone/,
    );
  });

  it('resolves by personId first, falls back to phone only if not found', async () => {
    const getPerson = vi.fn().mockResolvedValue(SAMPLE_PERSON);
    const searchPersonByPhone = vi.fn().mockResolvedValue(SAMPLE_PERSON);
    const deps = makeDeps({ getPerson, searchPersonByPhone });

    await getCustomerContext(deps, CONFIG, { personId: 42, phone: '+16175551111' });

    expect(getPerson).toHaveBeenCalledWith(42);
    expect(searchPersonByPhone).not.toHaveBeenCalled();
  });

  it('falls back to phone search when personId yields nothing', async () => {
    const getPerson = vi.fn().mockResolvedValue(null);
    const searchPersonByPhone = vi.fn().mockResolvedValue(SAMPLE_PERSON);
    const deps = makeDeps({ getPerson, searchPersonByPhone });

    const result = await getCustomerContext(deps, CONFIG, {
      personId: 999,
      phone: '+16175551111',
    });

    expect(result.person?.id).toBe(42);
    expect(searchPersonByPhone).toHaveBeenCalledWith('+16175551111');
  });

  it('summarizes person fields and constructs pdUrl', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue(SAMPLE_PERSON),
    });
    const result = await getCustomerContext(deps, CONFIG, { personId: 42 });

    expect(result.person).toMatchObject({
      id: 42,
      name: 'Jane Davis',
      phones: ['+16175551111'],
      emails: ['jane@example.com'],
      organizationId: 7,
      pdUrl: 'https://attackacrack.pipedrive.com/person/42',
    });
  });

  it('returns deals for the resolved person via getDealsByPerson', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue(SAMPLE_PERSON),
      getDealsByPerson: vi.fn().mockResolvedValue([
        {
          id: 100,
          title: 'Foundation repair',
          stage: 'quote_sent',
          status: 'open',
          personId: 42,
          value: 4200,
          qbEstimateId: 'qb-est-1',
          qbInvoiceId: null,
          externalId: null,
          lostReason: null,
          stageId: 5,
          pipelineId: 1,
          organizationId: null,
          currency: 'USD',
          addTime: '2026-05-01',
          updateTime: '2026-05-20',
        },
      ]),
    });

    const result = await getCustomerContext(deps, CONFIG, { personId: 42 });

    expect(result.deals).toHaveLength(1);
    expect(result.deals[0]).toMatchObject({ id: 100, stage: 'quote_sent', value: 4200 });
  });

  it('only returns calendar events tagged with one of this person\'s deal ids', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue(SAMPLE_PERSON),
      getDealsByPerson: vi.fn().mockResolvedValue([
        {
          id: 100,
          title: 'D',
          stage: 'job_scheduled',
          status: 'open',
          personId: 42,
          value: 0,
          qbEstimateId: null,
          qbInvoiceId: null,
          externalId: null,
          lostReason: null,
          stageId: 7,
          pipelineId: 1,
          organizationId: null,
          currency: 'USD',
          addTime: '',
          updateTime: '',
        },
      ]),
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt-a',
          summary: 'Davis foundation',
          description: 'Notes [deal:100]',
          start: '2026-06-01T13:00:00Z',
          end: '2026-06-01T16:00:00Z',
          colorId: '10',
          attendees: [],
          htmlLink: 'https://cal/evt-a',
          attachments: [],
        },
        {
          id: 'evt-b',
          summary: 'Smith porch',
          description: 'Notes [deal:200]',
          start: '2026-06-02T13:00:00Z',
          end: '2026-06-02T16:00:00Z',
          attendees: [],
          htmlLink: 'https://cal/evt-b',
          attachments: [],
        },
        {
          id: 'evt-c',
          summary: 'Untagged',
          description: 'No marker here',
          start: '2026-06-03T13:00:00Z',
          end: '2026-06-03T16:00:00Z',
          attendees: [],
          htmlLink: 'https://cal/evt-c',
          attachments: [],
        },
      ]),
    });

    const result = await getCustomerContext(deps, CONFIG, { personId: 42 });

    expect(result.recentEvents.map((e) => e.id)).toEqual(['evt-a']);
    expect(result.recentEvents[0].dealId).toBe(100);
  });

  it('uses the person\'s primary phone for Quo activity when phone arg is absent', async () => {
    const getRecentActivityForContact = vi
      .fn()
      .mockResolvedValue({ messages: [], calls: [] });
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue(SAMPLE_PERSON),
      getRecentActivityForContact,
    });

    await getCustomerContext(deps, CONFIG, { personId: 42 });

    expect(getRecentActivityForContact).toHaveBeenCalledWith(
      '+16175551111',
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('summarizes Quo messages and calls', async () => {
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue(SAMPLE_PERSON),
      getRecentActivityForContact: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'm-1',
            direction: 'incoming',
            from: '+16175551111',
            to: ['+16176681677'],
            text: 'when?',
            createdAt: '2026-05-20T12:00:00Z',
            updatedAt: '2026-05-20T12:00:00Z',
            phoneNumberId: 'pn-1',
            status: 'delivered',
          },
        ],
        calls: [
          {
            id: 'c-1',
            direction: 'outgoing',
            from: '+16176681677',
            to: '+16175551111',
            duration: 184,
            createdAt: '2026-05-21T15:00:00Z',
            phoneNumberId: 'pn-1',
            status: 'completed',
          },
        ],
      }),
    });

    const result = await getCustomerContext(deps, CONFIG, { personId: 42 });

    expect(result.recentMessages).toEqual([
      {
        id: 'm-1',
        direction: 'incoming',
        from: '+16175551111',
        to: ['+16176681677'],
        text: 'when?',
        createdAt: '2026-05-20T12:00:00Z',
      },
    ]);
    expect(result.recentCalls[0].durationSeconds).toBe(184);
  });
});
