import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QBEstimate, QBCustomer } from '@aac/api-clients/quickbooks';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

const mockIsConnected = vi.fn();
const mockListRecentEstimates = vi.fn();
const mockGetCustomer = vi.fn();
const mockSearchPersonByPhone = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getQuickBooks: () => ({
    isConnected: mockIsConnected,
    listRecentEstimates: mockListRecentEstimates,
    getCustomer: mockGetCustomer,
  }),
  getPipedrive: () => ({
    searchPersonByPhone: mockSearchPersonByPhone,
  }),
  getQuo: () => ({}),
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
  mockWritePendingDirective,
  mockTrackCronRun,
  mockLogHealthError,
} = vi.hoisted(() => ({
  mockGetDirectiveIdByEstimate: vi.fn(),
  mockWritePendingDirective: vi.fn(),
  mockTrackCronRun: vi.fn(),
  mockLogHealthError: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  getDirectiveIdByEstimate: mockGetDirectiveIdByEstimate,
  writePendingDirective: mockWritePendingDirective,
  trackCronRun: mockTrackCronRun,
  logHealthError: mockLogHealthError,
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
    mockWritePendingDirective.mockResolvedValue(undefined);
    mockTrackCronRun.mockResolvedValue(undefined);
    mockLogHealthError.mockResolvedValue(undefined);
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
    expect(mockListRecentEstimates).not.toHaveBeenCalled();
  });

  it('creates directives for accepted estimates with no prior directive', async () => {
    mockListRecentEstimates.mockResolvedValue([
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
    mockListRecentEstimates.mockResolvedValue([
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
    mockListRecentEstimates.mockResolvedValue([
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
    mockListRecentEstimates.mockResolvedValue([]);

    const req = makeReq({ windowDays: '14' });
    const res = makeRes();
    await handler(req, res);

    expect(mockListRecentEstimates).toHaveBeenCalledTimes(1);
    const since = mockListRecentEstimates.mock.calls[0][0] as string;
    // 14 days ago, YYYY-MM-DD
    const expected = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    expect(since).toBe(expected);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 14 }),
    );
  });

  it('defaults to 7-day window when query param missing or invalid', async () => {
    mockListRecentEstimates.mockResolvedValue([]);

    await handler(makeReq({ windowDays: 'not-a-number' }), makeRes());
    const since = mockListRecentEstimates.mock.calls[0][0] as string;
    const expected = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    expect(since).toBe(expected);
  });

  it('continues processing after one estimate errors and logs the failure', async () => {
    mockListRecentEstimates.mockResolvedValue([
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
    mockListRecentEstimates.mockResolvedValue([makeEstimate({ Id: 'est-1' })]);

    await handler(makeReq(), makeRes());

    expect(mockTrackCronRun).toHaveBeenCalledWith(
      'qb-reconcile',
      expect.objectContaining({ sent: 1, errors: 0 }),
    );
  });
});
