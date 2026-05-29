import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replayQbApprovals, type ReplayDeps } from '../src/replay.js';
import type { QBEstimate, QBCustomer } from '@aac/api-clients/quickbooks';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

function makeEstimate(overrides: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: '1234',
    SyncToken: '0',
    TxnStatus: 'Accepted',
    CustomerRef: { value: 'cust-99', name: 'Smith, John' },
    Line: [{ Description: 'Waterproof basement', Amount: 5500, DetailType: 'SalesItemLineDetail' }],
    TotalAmt: 5500,
    MetaData: {
      CreateTime: '2026-04-10T12:00:00.000Z',
      LastUpdatedTime: '2026-04-12T10:31:00.000Z',
    },
    ...overrides,
  };
}

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    summary: 'Job — Smith, John (waterproof)',
    description: 'Smith waterproof basement',
    start: '2026-04-15T13:00:00.000Z',
    end: '2026-04-15T17:00:00.000Z',
    colorId: '10',
    attendees: ['mike@example.com'],
    htmlLink: 'https://calendar.google.com/event?eid=evt-1',
    attachments: [],
    ...overrides,
  };
}

function makeDeps(opts: {
  estimates?: QBEstimate[];
  customer?: QBCustomer;
  pdPerson?: PipedrivePerson | null;
  calendarEvents?: CalendarEvent[];
} = {}): ReplayDeps {
  return {
    qb: {
      listRecentEstimates: vi.fn().mockResolvedValue(opts.estimates ?? [makeEstimate()]),
      getCustomer: vi.fn().mockResolvedValue(
        opts.customer ?? {
          Id: 'cust-99',
          DisplayName: 'Smith, John',
          PrimaryPhone: { FreeFormNumber: '(617) 555-0123' },
        },
      ),
    },
    pd: {
      searchPersonByPhone: vi.fn().mockResolvedValue(
        opts.pdPerson === undefined
          ? ({ id: 9001, name: 'John Smith' } as PipedrivePerson)
          : opts.pdPerson,
      ),
    },
    quo: {},
    cal: {
      listEvents: vi.fn().mockResolvedValue(opts.calendarEvents ?? [makeCalendarEvent()]),
    },
    newId: () => '01HQTEST',
    now: () => new Date('2026-05-29T15:00:00.000Z'),
  } as unknown as ReplayDeps;
}

const window = {
  from: new Date('2026-02-28T00:00:00.000Z'),
  to: new Date('2026-05-29T00:00:00.000Z'),
};

describe('replayQbApprovals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces a positive_match when calendar event matches', async () => {
    const deps = makeDeps();
    const { rows, summary } = await replayQbApprovals(deps, window);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('positive_match');
    expect(rows[0].directive).not.toBeNull();
    expect(rows[0].actualEvent?.id).toBe('evt-1');
    expect(summary.positiveMatches).toBe(1);
    expect(summary.agreementRate).toBe(1);
  });

  it('marks directive_no_event when normalizer fires but no calendar match', async () => {
    const deps = makeDeps({ calendarEvents: [] });
    const { rows, summary } = await replayQbApprovals(deps, window);
    expect(rows[0].verdict).toBe('directive_no_event');
    expect(summary.directivesWithNoEvent).toBe(1);
    expect(summary.positiveMatches).toBe(0);
  });

  it('marks directive_filtered when estimate is not Accepted', async () => {
    const deps = makeDeps({
      estimates: [makeEstimate({ TxnStatus: 'Pending' })],
    });
    const { rows } = await replayQbApprovals(deps, window);
    // Non-Accepted is filtered out at the listRecentEstimates filter stage.
    expect(rows).toHaveLength(0);
  });

  it('excludes estimates outside the date window', async () => {
    const deps = makeDeps({
      estimates: [
        makeEstimate({
          MetaData: { LastUpdatedTime: '2025-12-01T00:00:00.000Z' },
        }),
      ],
    });
    const { rows } = await replayQbApprovals(deps, window);
    expect(rows).toHaveLength(0);
  });

  it('filters by phone when --phone supplied', async () => {
    const deps = makeDeps();
    const { rows } = await replayQbApprovals(deps, {
      ...window,
      phone: '+19999999999', // not Smith
    });
    expect(rows).toHaveLength(0);
  });

  it('matches calendar event by customer name in description', async () => {
    const deps = makeDeps({
      calendarEvents: [
        makeCalendarEvent({
          summary: 'Repair work',
          description: 'John Smith - waterproof',
        }),
      ],
    });
    const { rows } = await replayQbApprovals(deps, window);
    expect(rows[0].verdict).toBe('positive_match');
  });

  it('sorts rows by timestamp ascending', async () => {
    const deps = makeDeps({
      estimates: [
        makeEstimate({
          Id: 'a',
          CustomerRef: { value: 'c1', name: 'Alice' },
          MetaData: { LastUpdatedTime: '2026-05-01T00:00:00.000Z' },
        }),
        makeEstimate({
          Id: 'b',
          CustomerRef: { value: 'c2', name: 'Bob' },
          MetaData: { LastUpdatedTime: '2026-04-01T00:00:00.000Z' },
        }),
      ],
      calendarEvents: [],
    });
    const { rows } = await replayQbApprovals(deps, window);
    expect(rows.map((r) => r.qbEstimateId)).toEqual(['b', 'a']);
  });

  it('summary.agreementRate is positiveMatches / rowCount', async () => {
    const deps = makeDeps({
      estimates: [
        makeEstimate({
          Id: 'a',
          CustomerRef: { value: 'c1', name: 'Alice' },
        }),
        makeEstimate({
          Id: 'b',
          CustomerRef: { value: 'c2', name: 'Bob' },
        }),
      ],
      calendarEvents: [makeCalendarEvent({ summary: 'Job — Alice' })], // matches Alice only
    });
    const { summary } = await replayQbApprovals(deps, window);
    expect(summary.rowCount).toBe(2);
    expect(summary.positiveMatches).toBe(1);
    expect(summary.agreementRate).toBe(0.5);
  });
});
