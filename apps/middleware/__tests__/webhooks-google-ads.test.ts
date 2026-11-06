import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../lib/redis.js', () => ({
  markEventProcessed: vi.fn().mockResolvedValue(true),
  storePhoneMapping: vi.fn().mockResolvedValue(undefined),
  trackWebhookProcessed: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: vi.fn(() => ({
    googleAds: { webhookKey: 'test-key' },
    quo: { phoneNumber: '+15550001111' },
    notifications: { alertPhoneNumber: '+15559999999' },
  })),
}));

const mockPipedrive = {
  searchPersonByPhone: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({ id: 200, name: 'New Lead', phone: [], email: [] }),
  updatePerson: vi.fn().mockResolvedValue({ id: 200, name: 'Updated', phone: [], email: [] }),
  createTask: vi.fn().mockResolvedValue({ id: 1 }),
};

const mockQuo = {
  sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
};

vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(() => mockPipedrive),
  getQuo: vi.fn(() => mockQuo),
}));

import handler from '../api/webhooks/google-ads.js';
import { markEventProcessed, trackWebhookProcessed } from '../lib/redis.js';
import { getEnv } from '../lib/env.js';

function makeReq(body: Record<string, unknown>, method = 'POST') {
  return { method, body } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    lead_id: 'lead-123',
    google_key: 'test-key',
    form_id: 1,
    campaign_id: 100,
    is_test: false,
    user_column_data: [
      { column_id: 'FULL_NAME', string_value: 'Jane Smith' },
      { column_id: 'PHONE_NUMBER', string_value: '+15551234567' },
      { column_id: 'EMAIL', string_value: 'jane@example.com' },
      { column_id: 'CITY', string_value: 'Boston' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (markEventProcessed as any).mockResolvedValue(true);
  mockPipedrive.searchPersonByPhone.mockResolvedValue(null);
  mockPipedrive.createPerson.mockResolvedValue({ id: 200, name: 'Jane Smith', phone: [], email: [] });
});

describe('google-ads webhook', () => {
  it('rejects non-POST requests', async () => {
    const res = makeRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('rejects invalid google_key', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload({ google_key: 'wrong-key' })), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects payload without lead_id', async () => {
    const res = makeRes();
    await handler(makeReq({ user_column_data: [] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('creates new Pipedrive person for new lead', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(mockPipedrive.searchPersonByPhone).toHaveBeenCalledWith('+15551234567');
    expect(mockPipedrive.createPerson).toHaveBeenCalledOnce();
    expect(mockPipedrive.createTask).toHaveBeenCalledOnce();
    expect(mockQuo.sendMessage).toHaveBeenCalledOnce();
    expect(trackWebhookProcessed).toHaveBeenCalledWith('google-ads');

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('processed');
    expect(body.isNewPerson).toBe(true);
  });

  it('uses existing person if found by phone', async () => {
    mockPipedrive.searchPersonByPhone.mockResolvedValue({
      id: 50, name: 'Existing Person', phone: [], email: [],
    });

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(mockPipedrive.createPerson).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.pipedrivePersonId).toBe(50);
    expect(body.isNewPerson).toBe(false);
  });

  it('deduplicates leads', async () => {
    (markEventProcessed as any).mockResolvedValue(false);

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('duplicate');
  });

  it('skips dedup for test leads', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload({ is_test: true })), res);

    expect(markEventProcessed).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('processed');
  });

  it('skips lead with no phone', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload({
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'No Phone Person' },
      ],
    })), res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('no_phone');
  });
});

describe('google-ads webhook key check', () => {
  const unsetKeyEnv = {
    googleAds: { webhookKey: null },
    quo: { phoneNumber: '+15550001111' },
    notifications: { alertPhoneNumber: '+15559999999' },
  };
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  });

  it('returns 503 and processes nothing when the key is unset in production', async () => {
    process.env.VERCEL_ENV = 'production';
    vi.mocked(getEnv).mockReturnValueOnce(unsetKeyEnv as ReturnType<typeof getEnv>);
    const res = makeRes();
    await handler(makeReq(makePayload({ google_key: 'anything' })), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(markEventProcessed).not.toHaveBeenCalled();
    expect(mockPipedrive.createPerson).not.toHaveBeenCalled();
    expect(mockQuo.sendMessage).not.toHaveBeenCalled();
  });

  it('still accepts when the key is unset outside production (preview/local)', async () => {
    process.env.VERCEL_ENV = 'preview';
    vi.mocked(getEnv).mockReturnValueOnce(unsetKeyEnv as ReturnType<typeof getEnv>);
    const res = makeRes();
    await handler(makeReq(makePayload()), res);
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].status).toBe('processed');
  });

  it('returns 401 in production when google_key is missing or wrong', async () => {
    process.env.VERCEL_ENV = 'production';
    for (const google_key of [undefined, '', 'test-ke', 'test-key-extra']) {
      const res = makeRes();
      await handler(makeReq(makePayload({ google_key })), res);
      expect(res.status, String(google_key)).toHaveBeenCalledWith(401);
    }
    expect(markEventProcessed).not.toHaveBeenCalled();
  });

  it('processes the lead in production with the right key', async () => {
    process.env.VERCEL_ENV = 'production';
    const res = makeRes();
    await handler(makeReq(makePayload()), res);
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(mockPipedrive.createPerson).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0].status).toBe('processed');
  });
});
