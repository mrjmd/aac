import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRouter = vi.hoisted(() => ({
  runInboundTick: vi.fn().mockResolvedValue({ mode: 'shadow', due: 0, entries: [] }),
}));
vi.mock('@aac/inbound-router', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mockRouter,
}));

const redisMock = { set: vi.fn() };
vi.mock('../lib/deps.js', () => ({
  getWorkerDeps: vi.fn(() => ({ deps: { quo: { q: 1 }, gemini: { g: 1 } }, redis: redisMock })),
}));

import { GET as inboundTick } from '../api/inbound-tick.js';

const req = (headers: Record<string, string> = {}) => new Request('https://worker.test/api/inbound-tick', { headers });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('/api/inbound-tick', () => {
  it('rejects anything but the cron bearer or the worker secret', async () => {
    expect((await inboundTick(req())).status).toBe(401);
    expect((await inboundTick(req({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect(mockRouter.runInboundTick).not.toHaveBeenCalled();
  });

  it('runs one shadow pass with the worker clients and the can-help store', async () => {
    mockRouter.runInboundTick.mockResolvedValueOnce({
      mode: 'shadow',
      due: 2,
      entries: [{ at: 'x', phone: '+15085551234', outcome: 'decided', routes: [{ route: 'decline', why: 'block' }] }],
    });
    const res = await inboundTick(req({ authorization: 'Bearer cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', mode: 'shadow', due: 2, read: 1 });
    const deps = mockRouter.runInboundTick.mock.calls[0][0];
    expect(deps.redis).toBe(redisMock);
    expect(deps.quo).toEqual({ q: 1 });
    expect(typeof deps.canHelp.rules).toBe('function');
  });

  it('a router failure is a 500 with the message, not a crash', async () => {
    mockRouter.runInboundTick.mockRejectedValueOnce(new Error('redis down'));
    const res = await inboundTick(req({ authorization: 'Bearer cron-secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: 'error', message: 'redis down' });
  });
});
