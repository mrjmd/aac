import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  scan: vi.fn().mockResolvedValue([0, []]),
  lrange: vi.fn().mockResolvedValue([]),
};

vi.mock('../lib/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
}));

import handler from '../api/health.js';

function makeReq(method = 'GET') {
  return { method } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.scan.mockResolvedValue([0, []]);
  mockRedis.lrange.mockResolvedValue([]);
});

describe('health endpoint', () => {
  it('returns 405 for non-GET requests', async () => {
    const res = makeRes();
    await handler(makeReq('POST'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 200 with health metrics', async () => {
    // redis.get is called for webhook counts and last-processed timestamps
    // Just return 0/null for everything — we're testing the response shape
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('v2026-03-31-monorepo');
    expect(body.metrics.webhooks).toBeDefined();
    expect(body.metrics.webhooks.pipedrive).toBeDefined();
    expect(body.metrics.webhooks.quo).toBeDefined();
    expect(body.metrics.webhooks.googleAds).toBeDefined();
    expect(body.metrics.sync).toBeDefined();
    expect(body.metrics.errors).toEqual([]);
  });

  it('includes parsed errors from Redis', async () => {
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({ timestamp: '2026-03-31T10:00:00Z', source: 'pipedrive', message: 'API timeout' }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.metrics.errors).toHaveLength(1);
    expect(body.metrics.errors[0].source).toBe('pipedrive');
  });

  it('writes heartbeat on success', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockRedis.set).toHaveBeenCalled();
    // Find the heartbeat call
    const heartbeatCall = mockRedis.set.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('middleware')
    );
    expect(heartbeatCall).toBeDefined();
  });

  it('handles Redis failure gracefully', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis down'));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('error');
  });
});
