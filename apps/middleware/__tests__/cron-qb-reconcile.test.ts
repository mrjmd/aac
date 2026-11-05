import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QBEstimate, QBCustomer } from '@aac/api-clients/quickbooks';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

const mockIsConnected = vi.fn();
const mockListEstimatesUpdatedSince = vi.fn();
const mockGetCustomer = vi.fn();
const mockSearchPersonByPhone = vi.fn();
const mockListEvents = vi.fn();
const mockListAllCustomers = vi.fn();
const mockGetEstimatesByCustomer = vi.fn();
const mockUpdateEstimate = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getQuickBooks: () => ({
    isConnected: mockIsConnected,
    listEstimatesUpdatedSince: mockListEstimatesUpdatedSince,
    getCustomer: mockGetCustomer,
    listAllCustomers: mockListAllCustomers,
    getEstimatesByCustomer: mockGetEstimatesByCustomer,
    updateEstimate: mockUpdateEstimate,
  }),
  getPipedrive: () => ({
    searchPersonByPhone: mockSearchPersonByPhone,
  }),
  getQuo: () => ({}),
  getCalendar: () => ({
    listEvents: mockListEvents,
  }),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    cron: { secret: 'test-secret' },
    nodeEnv: 'development',
  }),
}));

vi.mock('../lib/cron.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/cron.js')>('../lib/cron.js');
  return { ...actual, verifyCronAuth: () => true };
});

const {
  mockGetDirectiveIdByEstimate,
  mockMarkEstimateHandled,
  mockWritePendingDirective,
  mockTrackCronRun,
  mockLogHealthError,
  mockGetBookingSyncOutcome,
  mockSetBookingSyncOutcome,
} = vi.hoisted(() => ({
  mockGetBookingSyncOutcome: vi.fn(),
  mockSetBookingSyncOutcome: vi.fn(),
  mockGetDirectiveIdByEstimate: vi.fn(),
  mockMarkEstimateHandled: vi.fn(),
  mockWritePendingDirective: vi.fn(),
  mockTrackCronRun: vi.fn(),
  mockLogHealthError: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  getDirectiveIdByEstimate: mockGetDirectiveIdByEstimate,
  markEstimateHandled: mockMarkEstimateHandled,
  writePendingDirective: mockWritePendingDirective,
  trackCronRun: mockTrackCronRun,
  logHealthError: mockLogHealthError,
  getBookingSyncOutcome: mockGetBookingSyncOutcome,
  setBookingSyncOutcome: mockSetBookingSyncOutcome,
}));

import handler from '../api/cron/qb-reconcile.js';

// ── fixtures ──────────────────────────────────────────────────────

function makeReq(query: Record<string, string> = {}) {
  return {
    method: 'GET',
    query,
    headers: { authorization: 'Bearer test-secret' },
  } as never;
}

function makeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeEstimate(overrides: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: 'est-1',
    SyncToken: '0',
    TxnStatus: 'Accepted',
    CustomerRef: { value: 'cust-1', name: 'Smith, John' },
    Line: [
      { Description: 'crack injection', Amount: 1200, DetailType: 'SalesItemLineDetail' },
    ],
    TotalAmt: 1200,
    ...overrides,
  };
}

function makeCustomer(): QBCustomer {
  return {
    Id: 'cust-1',
    DisplayName: 'Smith, John',
    PrimaryPhone: { FreeFormNumber: '(617) 555-0123' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makePerson(): PipedrivePerson {
  return {
    id: 9001,
    name: 'John Smith',
    phone: [{ value: '+16175550123', primary: true, label: 'work' }],
    email: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ── tests ─────────────────────────────────────────────────────────

describe('qb-reconcile cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockResolvedValue(true);
    mockGetCustomer.mockResolvedValue(makeCustomer());
    mockSearchPersonByPhone.mockResolvedValue(makePerson());
    mockGetDirectiveIdByEstimate.mockResolvedValue(null);
    mockMarkEstimateHandled.mockResolvedValue(undefined);
    mockWritePendingDirective.mockResolvedValue(undefined);
    mockTrackCronRun.mockResolvedValue(undefined);
    mockLogHealthError.mockResolvedValue(undefined);
    mockListEvents.mockResolvedValue([]);
    mockListAllCustomers.mockResolvedValue([]);
    mockGetEstimatesByCustomer.mockResolvedValue([]);
    mockGetBookingSyncOutcome.mockResolvedValue(null);
    mockSetBookingSyncOutcome.mockResolvedValue(undefined);
  });

  describe('booking → QBO acceptance sync', () => {
    const greenJob = {
      id: 'evt-job',
      summary: 'John Smith',
      start: '2026-11-12T13:00:00Z',
      end: '2026-11-12T17:00:00Z',
      colorId: '10',
      attendees: [],
      htmlLink: '',
      attachments: [],
    };

    it("marks a booked customer's one open quote Accepted", async () => {
      mockListEstimatesUpdatedSince.mockResolvedValue([]);
      mockListEvents.mockResolvedValue([greenJob]);
      mockListAllCustomers.mockResolvedValue([makeCustomer()]);
      mockGetEstimatesByCustomer.mockResolvedValue([
        makeEstimate({ Id: 'est-open', TxnStatus: 'Pending', TxnDate: '2026-10-20' }),
      ]);

      const res = makeRes();
      await handler(makeReq(), res);

      expect(mockMarkEstimateHandled).toHaveBeenCalledWith('est-open', 'booking-sync:evt-job');
      expect(mockUpdateEstimate).toHaveBeenCalledWith(
        'est-open',
        expect.objectContaining({ txnStatus: 'Accepted' }),
      );
      expect(mockSetBookingSyncOutcome).toHaveBeenCalledWith('evt-job', 'accepted:est-open', true);
      expect(res.json.mock.calls[0][0].summary.bookingSync).toMatchObject({ jobs: 1, accepted: 1 });
    });

    it('does not run when the calendar is unavailable', async () => {
      mockListEstimatesUpdatedSince.mockResolvedValue([]);
      mockListEvents.mockRejectedValue(new Error('cal 500'));

      const res = makeRes();
      await handler(makeReq(), res);

      expect(mockListAllCustomers).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].summary.bookingSync).toBeNull();
    });

    it('a sync failure is counted but the directive pass still lands', async () => {
      mockListEstimatesUpdatedSince.mockResolvedValue([makeEstimate({ Id: 'est-new' })]);
      mockListEvents.mockResolvedValue([{ ...greenJob, summary: 'Someone Else' }]);
      mockListAllCustomers.mockRejectedValue(new Error('qbo 500'));

      const res = makeRes();
      await handler(makeReq(), res);

      expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
      expect(res.json.mock.calls[0][0].summary.errors).toBe(1);
      expect(mockLogHealthError).toHaveBeenCalledWith('qb-reconcile', 'booking-sync: qbo 500');
    });
  });

  it('skips an estimate whose customer already has an upcoming event (prereq 1)', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([makeEstimate({ Id: 'est-manual' })]);
    mockListEvents.mockResolvedValue([
      {
        id: 'evt-booked',
        summary: 'John Smith — crack injection rear wall',
        start: '2026-11-03T13:00:00Z',
        end: '2026-11-03T17:00:00Z',
        attendees: [],
        htmlLink: '',
        attachments: [],
      },
    ]);

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).not.toHaveBeenCalled();
    expect(mockMarkEstimateHandled).toHaveBeenCalledWith(
      'est-manual',
      'manual-scheduled:evt-booked',
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.summary.manuallyScheduled).toBe(1);
  });

  it('does not skip when the upcoming event belongs to a different customer', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([makeEstimate({ Id: 'est-other' })]);
    mockListEvents.mockResolvedValue([
      {
        id: 'evt-jane',
        summary: 'Jane Smith — sump pump',
        start: '2026-11-03T13:00:00Z',
        end: '2026-11-03T17:00:00Z',
        attendees: [],
        htmlLink: '',
        attachments: [],
      },
    ]);

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockMarkEstimateHandled).not.toHaveBeenCalled();
    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
  });

  it('degrades to directive creation when the calendar is unavailable', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([makeEstimate({ Id: 'est-cal-down' })]);
    mockListEvents.mockRejectedValue(new Error('cal 500'));

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
    expect(mockMarkEstimateHandled).not.toHaveBeenCalled();
  });

  it('skips when QuickBooks is not connected', async () => {
    mockIsConnected.mockResolvedValue(false);

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'skipped',
      reason: 'qb_not_connected',
    });
    expect(mockListEstimatesUpdatedSince).not.toHaveBeenCalled();
  });

  it('creates directives for accepted estimates with no prior directive', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([
      makeEstimate({ Id: 'est-1' }),
      makeEstimate({ Id: 'est-2', CustomerRef: { value: 'cust-1', name: 'Smith, John' } }),
    ]);

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(2);
    const calls = mockWritePendingDirective.mock.calls;
    expect(calls[0][0].source).toBe('qb_reconciliation');
    expect(calls[0][0].qbEstimateId).toBe('est-1');
    expect(calls[1][0].qbEstimateId).toBe('est-2');

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        summary: expect.objectContaining({
          scanned: 2,
          accepted: 2,
          directivesCreated: 2,
          alreadyDirectived: 0,
        }),
      }),
    );
  });

  it('skips estimates that already have a directive (dedup against webhook)', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([
      makeEstimate({ Id: 'est-already' }),
      makeEstimate({ Id: 'est-new' }),
    ]);
    mockGetDirectiveIdByEstimate.mockImplementation((id: string) =>
      Promise.resolve(id === 'est-already' ? '01HQEXISTING' : null),
    );

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
    expect(mockWritePendingDirective.mock.calls[0][0].qbEstimateId).toBe('est-new');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          scanned: 2,
          accepted: 2,
          alreadyDirectived: 1,
          directivesCreated: 1,
        }),
      }),
    );
  });

  it('ignores non-Accepted estimates', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([
      makeEstimate({ Id: 'est-pending', TxnStatus: 'Pending' }),
      makeEstimate({ Id: 'est-rejected', TxnStatus: 'Rejected' }),
      makeEstimate({ Id: 'est-accepted', TxnStatus: 'Accepted' }),
    ]);

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
    expect(mockWritePendingDirective.mock.calls[0][0].qbEstimateId).toBe('est-accepted');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          scanned: 3,
          accepted: 1,
        }),
      }),
    );
  });

  it('uses requested windowDays when provided', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([]);

    const req = makeReq({ windowDays: '14' });
    const res = makeRes();
    await handler(req, res);

    expect(mockListEstimatesUpdatedSince).toHaveBeenCalledTimes(1);
    const since = Date.parse(mockListEstimatesUpdatedSince.mock.calls[0][0] as string);
    expect(Math.abs(since - (Date.now() - 14 * 86_400_000))).toBeLessThan(5_000);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 14 }),
    );
  });

  it('defaults to 7-day window when query param missing or invalid', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([]);

    await handler(makeReq({ windowDays: 'not-a-number' }), makeRes());
    const since = Date.parse(mockListEstimatesUpdatedSince.mock.calls[0][0] as string);
    expect(Math.abs(since - (Date.now() - 7 * 86_400_000))).toBeLessThan(5_000);
  });

  it('skips an Accepted quote that is already invoiced (an edit bumped LastUpdatedTime)', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([
      makeEstimate({ Id: 'est-invoiced', LinkedTxn: [{ TxnId: 'inv-9', TxnType: 'Invoice' }] }),
      makeEstimate({ Id: 'est-open' }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
    expect(mockWritePendingDirective.mock.calls[0][0].qbEstimateId).toBe('est-open');
    expect(mockGetDirectiveIdByEstimate).not.toHaveBeenCalledWith('est-invoiced');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.objectContaining({ filtered: 1, directivesCreated: 1 }) }),
    );
  });

  it('continues processing after one estimate errors and logs the failure', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([
      makeEstimate({ Id: 'est-good-1' }),
      makeEstimate({ Id: 'est-bad' }),
      makeEstimate({ Id: 'est-good-2' }),
    ]);
    mockGetDirectiveIdByEstimate.mockImplementation((id: string) => {
      if (id === 'est-bad') throw new Error('redis blip');
      return Promise.resolve(null);
    });

    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(mockWritePendingDirective).toHaveBeenCalledTimes(2);
    expect(mockLogHealthError).toHaveBeenCalledWith(
      'qb-reconcile',
      'redis blip',
      expect.objectContaining({ estimateId: 'est-bad' }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          accepted: 3,
          directivesCreated: 2,
          errors: 1,
        }),
      }),
    );
  });

  it('tracks the run via trackCronRun', async () => {
    mockListEstimatesUpdatedSince.mockResolvedValue([makeEstimate({ Id: 'est-1' })]);

    await handler(makeReq(), makeRes());

    expect(mockTrackCronRun).toHaveBeenCalledWith(
      'qb-reconcile',
      expect.objectContaining({ sent: 1, errors: 0 }),
    );
  });
});
