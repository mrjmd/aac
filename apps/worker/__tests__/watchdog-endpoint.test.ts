import { describe, it, expect, vi, beforeEach } from 'vitest';

const tick = vi.hoisted(() => vi.fn().mockResolvedValue({ down: [], texted: [], recovered: [] }));
vi.mock('@aac/watchdog', () => ({ runWatchdogTick: tick }));
vi.mock('../lib/watchdog-deps.js', () => ({ getWatchdogDeps: vi.fn(() => ({})) }));

import { GET as watchdog } from '../api/watchdog.js';

const req = (headers: Record<string, string> = {}) => new Request('https://worker.test/api/watchdog', { headers });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('watchdog endpoint', () => {
  it('runs only for the Vercel cron', async () => {
    expect((await watchdog(req({ authorization: 'Bearer cron-secret' }))).status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
    expect((await watchdog(req({ 'x-worker-secret': 'worker-secret' }))).status).toBe(401);
    expect((await watchdog(req())).status).toBe(401);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('reports a failed tick as a 500', async () => {
    tick.mockRejectedValueOnce(new Error('redis down'));
    const res = await watchdog(req({ authorization: 'Bearer cron-secret' }));
    expect(res.status).toBe(500);
  });
});
