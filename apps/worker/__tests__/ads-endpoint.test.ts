import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.hoisted(() => vi.fn().mockResolvedValue({ mode: 'dry', uploaded: 0, failed: [] }));
const getAdsDeps = vi.hoisted(() => vi.fn((): object | null => ({})));
vi.mock('@aac/ads-conversions', () => ({ runAdsConversions: run }));
vi.mock('../lib/ads-deps.js', () => ({
  getAdsDeps,
  adsMode: () => (process.env.ADS_CONVERSIONS_MODE ?? 'off'),
}));

import { GET } from '../api/ads-conversions.js';

const cron = (q = '') =>
  new Request(`https://worker.test/api/ads-conversions${q}`, { headers: { authorization: 'Bearer cron-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.ADS_CONVERSIONS_MODE = 'dry';
});

describe('ads-conversions endpoint', () => {
  it('rejects callers without a secret', async () => {
    expect((await GET(new Request('https://worker.test/api/ads-conversions'))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing while off', async () => {
    process.env.ADS_CONVERSIONS_MODE = 'off';
    const body = await (await GET(cron())).json();
    expect(body.skipped).toBe('off');
    expect(run).not.toHaveBeenCalled();
  });

  it('skips without the Ads env', async () => {
    getAdsDeps.mockReturnValueOnce(null);
    expect((await (await GET(cron())).json()).skipped).toBe('no-ads-env');
  });

  it('runs with a 3-day default and a bounded ?days', async () => {
    await GET(cron());
    await GET(cron('?days=90'));
    await GET(cron('?days=400'));
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      { mode: 'dry', lookbackDays: 3 },
      { mode: 'dry', lookbackDays: 90 },
      { mode: 'dry', lookbackDays: 3 },
    ]);
  });

  it('reports a failed run as a 500', async () => {
    run.mockRejectedValueOnce(new Error('ga down'));
    expect((await GET(cron())).status).toBe(500);
  });
});
