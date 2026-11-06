import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ found: 5, added: 2, graded: 3, errors: 0, partial: false, byGrade: { waiting: 2, 'as-is': 1, cosmetic: 0, changed: 2, 'thrown-out': 0, unused: 0 } }),
);
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
vi.mock('@aac/grader', () => ({ runGrader: run }));
vi.mock('../lib/deps.js', () => ({ getWorkerDeps: () => ({ redis, deps: { qb: {}, quo: {} } }) }));
vi.mock('../lib/health.js', () => ({ guarded: (_r: string, f: () => Promise<Response>) => f(), recordRun, recordFailure }));

import { keys } from '@aac/shared-utils/redis';
import { GET } from '../api/grader.js';

const cron = () => new Request('https://worker.test/api/grader', { headers: { authorization: 'Bearer cron-secret' } });
const forced = () => new Request('https://worker.test/api/grader?force=1', { headers: { 'x-worker-secret': 'worker-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  kv.set(keys.graderMode, 'dry');
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('grader endpoint', () => {
  it('rejects callers without a secret', async () => {
    expect((await GET(new Request('https://worker.test/api/grader'))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing while off (unset or unknown)', async () => {
    kv.delete(keys.graderMode);
    expect((await (await GET(cron())).json()).skipped).toBe('off');
    kv.set(keys.graderMode, 'banana');
    expect((await (await GET(cron())).json()).skipped).toBe('off');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs once a day per mode with a time budget; force runs again', async () => {
    const body = await (await GET(cron())).json();
    expect(body).toMatchObject({ status: 'ok', mode: 'dry', graded: 3, added: 2 });
    expect(run.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(run.mock.calls[0][1].deadlineMs).toBeGreaterThan(Date.now());
    expect(recordRun).toHaveBeenCalledWith('grader', { sent: 3, skipped: 2, errors: 0 });
    expect((await (await GET(cron())).json()).skipped).toBe('done-today');
    kv.set(keys.graderMode, 'live');
    await GET(cron());
    expect(run.mock.calls[1][1]).toMatchObject({ dryRun: false });
    await GET(forced());
    expect(run).toHaveBeenCalledTimes(3);
    expect(kv.has(keys.graderRunLock)).toBe(false);
  });

  it('skips while another run holds the lock', async () => {
    kv.set(keys.graderRunLock, '1');
    expect((await (await GET(cron())).json()).skipped).toBe('locked');
    expect(run).not.toHaveBeenCalled();
  });

  it('records a failure and releases the lock', async () => {
    run.mockRejectedValueOnce(new Error('qbo down'));
    const res = await GET(cron());
    expect(res.status).toBe(500);
    expect(recordFailure).toHaveBeenCalledWith('grader', 'grader failed: qbo down');
    expect(recordRun).not.toHaveBeenCalled();
    expect(kv.has(keys.graderRunLock)).toBe(false);
  });
});
