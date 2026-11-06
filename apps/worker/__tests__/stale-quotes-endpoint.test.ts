import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ partial: false, pendingInScope: 3, queue: { toSend: [1], waiting: [], flags: [], skipped: [1, 2] }, awaiting: [] }),
);
const mode = vi.hoisted(() => ({ value: 'dry' as string }));
const getStaleQuoteDeps = vi.hoisted(() => vi.fn((): object | null => ({})));
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
vi.mock('@aac/stale-quotes', () => ({ runStaleQuotes: run }));
vi.mock('../lib/deps.js', () => ({ getWorkerDeps: () => ({ redis }) }));
vi.mock('../lib/stale-quotes-deps.js', () => ({ getStaleQuoteDeps, staleQuotesMode: async () => mode.value }));

import { GET } from '../api/stale-quotes.js';

const cron = () => new Request('https://worker.test/api/stale-quotes', { headers: { authorization: 'Bearer cron-secret' } });
const forced = () => new Request('https://worker.test/api/stale-quotes?force=1', { headers: { 'x-worker-secret': 'worker-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  mode.value = 'dry';
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('stale-quotes endpoint', () => {
  it('rejects callers without a secret', async () => {
    expect((await GET(new Request('https://worker.test/api/stale-quotes'))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing while off, or without the Google env', async () => {
    mode.value = 'off';
    expect((await (await GET(cron())).json()).skipped).toBe('off');
    mode.value = 'dry';
    getStaleQuoteDeps.mockReturnValueOnce(null);
    expect((await (await GET(cron())).json()).skipped).toBe('no-google-env');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs once a day per mode, with a time budget; force runs again', async () => {
    const body = await (await GET(cron())).json();
    expect(body).toMatchObject({ status: 'ok', mode: 'dry', drafted: 1, skipped: 2 });
    expect(run.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(run.mock.calls[0][1].deadlineMs).toBeGreaterThan(Date.now());
    expect((await (await GET(cron())).json()).skipped).toBe('done-today');
    mode.value = 'live';
    await GET(cron());
    expect(run.mock.calls[1][1]).toMatchObject({ dryRun: false });
    await GET(forced());
    expect(run).toHaveBeenCalledTimes(3);
    expect(kv.has('stale-quotes:run-lock')).toBe(false);
  });

  it('a scan cut short runs again in the next slot', async () => {
    run.mockResolvedValueOnce({ partial: true, pendingInScope: 3, queue: { toSend: [], waiting: [], flags: [], skipped: [] }, awaiting: [] });
    await GET(cron());
    await GET(cron());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips while another run holds the lock', async () => {
    kv.set('stale-quotes:run-lock', '1');
    expect((await (await GET(cron())).json()).skipped).toBe('locked');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a failed run as a 500 and releases the lock', async () => {
    run.mockRejectedValueOnce(new Error('qbo down'));
    expect((await GET(cron())).status).toBe(500);
    expect(kv.has('stale-quotes:run-lock')).toBe(false);
  });
});
