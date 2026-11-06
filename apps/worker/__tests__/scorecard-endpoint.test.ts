import { describe, it, expect, vi, beforeEach } from 'vitest';

const result = (partial = false) => ({ scorecard: { rows: new Array(10).fill({}), gaps: [] }, leadsChecked: 4, leadsAdded: 2, partial });
const run = vi.hoisted(() => vi.fn());
const kv = vi.hoisted(() => new Map<string, unknown>());
const redis = vi.hoisted(() => ({
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => {
    if (o?.nx && kv.has(k)) return null;
    kv.set(k, typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => kv.delete(k)),
}));
const recordRun = vi.hoisted(() => vi.fn());
const recordFailure = vi.hoisted(() => vi.fn());
vi.mock('@aac/metrics', () => ({ runScorecard: run }));
vi.mock('../lib/deps.js', () => ({ getWorkerDeps: () => ({ redis, deps: { qb: {}, quo: {} } }) }));
vi.mock('../lib/ads-deps.js', () => ({ adsClient: () => null }));
vi.mock('../lib/health.js', () => ({ guarded: (_r: string, f: () => Promise<Response>) => f(), recordRun, recordFailure }));

import { keys } from '@aac/shared-utils/redis';
import { GET } from '../api/scorecard.js';

const cron = () => new Request('https://worker.test/api/scorecard', { headers: { authorization: 'Bearer cron-secret' } });
const forced = () => new Request('https://worker.test/api/scorecard?force=1', { headers: { 'x-worker-secret': 'worker-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue(result());
  kv.clear();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'token';
});

describe('scorecard endpoint', () => {
  it('rejects callers without a secret', async () => {
    expect((await GET(new Request('https://worker.test/api/scorecard'))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips without the Google env', async () => {
    delete process.env.GOOGLE_REFRESH_TOKEN;
    expect((await (await GET(cron())).json()).skipped).toBe('no-google-env');
  });

  it('runs once a day, reading leads from the last run minus a day; force runs again', async () => {
    const body = await (await GET(cron())).json();
    expect(body).toMatchObject({ status: 'ok', leadsChecked: 4, leadsAdded: 2 });
    expect(run.mock.calls[0][1].leadsSince.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(run.mock.calls[0][0].ads).toBeNull();
    expect(recordRun).toHaveBeenCalledWith('scorecard', { sent: 10, skipped: 0, errors: 0 });
    expect((await (await GET(cron())).json()).skipped).toBe('done-today');
    await GET(forced());
    const lastAt = Date.parse((kv.get(keys.scorecardLastRun) as { at: string }).at);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1].leadsSince.getTime()).toBeLessThan(lastAt);
    expect(kv.has(keys.scorecardRunLock)).toBe(false);
  });

  it('keeps the old lead cursor after a partial pass', async () => {
    kv.set(keys.scorecardLastRun, { day: '2026-11-01', at: '2026-11-01T09:00:00.000Z' });
    run.mockResolvedValueOnce(result(true));
    await GET(cron());
    expect((kv.get(keys.scorecardLastRun) as { at: string }).at).toBe('2026-11-01T09:00:00.000Z');
  });

  it('records a failure and releases the lock', async () => {
    run.mockRejectedValueOnce(new Error('qbo down'));
    expect((await GET(cron())).status).toBe(500);
    expect(recordFailure).toHaveBeenCalledWith('scorecard', 'scorecard failed: qbo down');
    expect(kv.has(keys.scorecardRunLock)).toBe(false);
  });
});
