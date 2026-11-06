import { describe, it, expect, vi, beforeEach } from 'vitest';

const findings = vi.hoisted(() => ({
  generatedAt: '2026-11-05T13:05:00.000Z',
  findings: [{ section: 'conversation' }, { section: 'conversation' }, { section: 'stale_estimate' }],
  stats: { llmErrors: 0, emailSweepOk: 1, geminiCanaryOk: 1 } as Record<string, number>,
}));
const candidates = vi.hoisted(() => [{ key: 'a', detector: 'L1' }, { key: 'b', detector: 'D5' }]);
const collect = vi.hoisted(() => vi.fn(async () => ({ snapshot: true })));
const analyze = vi.hoisted(() => vi.fn(async () => findings));
const triageCandidates = vi.hoisted(() => vi.fn(() => candidates));
const publishTriageItems = vi.hoisted(() => vi.fn(async () => undefined));
const recordFailure = vi.hoisted(() => vi.fn(async () => undefined));
const recordRun = vi.hoisted(() => vi.fn(async () => undefined));
const mode = vi.hoisted(() => ({ value: 'dry' as string }));
const missing = vi.hoisted(() => ({ value: null as string | null }));
const kv = vi.hoisted(() => new Map<string, unknown>());
const redis = vi.hoisted(() => ({
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => {
    if (o?.nx && kv.has(k)) return null;
    kv.set(k, typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v);
    return 'OK';
  }),
  // RELEASE_LOCK_LUA: compare-and-delete.
  eval: vi.fn(async (_script: string, ks: string[], args: string[]) => {
    if (kv.get(ks[0]) !== args[0]) return 0;
    kv.delete(ks[0]);
    return 1;
  }),
}));
const staleLists = vi.hoisted(() => ({ queue: null, awaiting: null }));

vi.mock('@aac/triage', () => ({ collect, analyze, triageCandidates, publishTriageItems }));
vi.mock('../lib/health.js', () => ({
  recordFailure,
  recordRun,
  guarded: async (_route: string, handle: () => Promise<Response>) => handle(),
}));
vi.mock('../lib/triage-deps.js', () => ({
  missingTriageEnv: () => missing.value,
  triageMode: async () => mode.value,
  getTriageDeps: () => ({
    redis,
    collect: { now: () => Date.now() },
    analyze: { now: () => Date.now() },
    loadStaleLists: async () => staleLists,
  }),
}));

import { GET } from '../api/triage.js';

const cron = () => new Request('https://worker.test/api/triage', { headers: { authorization: 'Bearer cron-secret' } });
const forced = () => new Request('https://worker.test/api/triage?force=1', { headers: { 'x-worker-secret': 'worker-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  mode.value = 'dry';
  missing.value = null;
  findings.stats = { llmErrors: 0, emailSweepOk: 1, geminiCanaryOk: 1 };
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('triage endpoint', () => {
  it('rejects callers without a secret', async () => {
    expect((await GET(new Request('https://worker.test/api/triage'))).status).toBe(401);
    const wrong = new Request('https://worker.test/api/triage', { headers: { authorization: 'Bearer nope' } });
    expect((await GET(wrong)).status).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it('fails closed when the secrets are unset', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(new Request('https://worker.test/api/triage', { headers: { authorization: 'Bearer ' } }))).status).toBe(401);
  });

  it('does nothing while off', async () => {
    mode.value = 'off';
    expect((await (await GET(cron())).json()).skipped).toBe('off');
    expect(collect).not.toHaveBeenCalled();
  });

  it('skips (never crashes) when env is missing', async () => {
    missing.value = 'no-google-env';
    const res = await GET(cron());
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('no-google-env');
    expect(collect).not.toHaveBeenCalled();
  });

  it('dry computes and records counts without publishing', async () => {
    const body = await (await GET(cron())).json();
    expect(body).toMatchObject({
      status: 'ok',
      mode: 'dry',
      findings: 3,
      bySection: { conversation: 2, stale_estimate: 1 },
      candidates: 2,
      byDetector: { L1: 1, D5: 1 },
      published: false,
    });
    expect(publishTriageItems).not.toHaveBeenCalled();
    expect(kv.get('triage:last-run')).toMatchObject({ mode: 'dry', candidates: 2 });
    expect(recordRun).toHaveBeenCalledWith('triage', { sent: 0, skipped: 0, errors: 0 });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('builds candidates without bot-draft labels', async () => {
    await GET(cron());
    const [data, stale, ctx] = triageCandidates.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(data).toBe(findings);
    expect(stale).toBe(staleLists);
    expect(Object.keys(ctx)).toEqual(['now']);
  });

  it('live publishes the candidates as triage-worker', async () => {
    mode.value = 'live';
    const body = await (await GET(cron())).json();
    expect(body.published).toBe(true);
    expect(publishTriageItems).toHaveBeenCalledWith(
      { redis },
      { at: findings.generatedAt, source: 'triage-worker', candidates },
    );
    expect(recordRun).toHaveBeenCalledWith('triage', { sent: 2, skipped: 0, errors: 0 });
  });

  it('runs once a day per mode; force runs again', async () => {
    await GET(cron());
    expect((await (await GET(cron())).json()).skipped).toBe('done-today');
    mode.value = 'live';
    await GET(cron());
    expect((await (await GET(cron())).json()).skipped).toBe('done-today');
    await GET(forced());
    expect(collect).toHaveBeenCalledTimes(3);
    expect(kv.has('triage:run-lock')).toBe(false);
  });

  it('force needs the middleware secret (cron ?force=1 still once a day)', async () => {
    await GET(cron());
    const cronForce = new Request('https://worker.test/api/triage?force=1', { headers: { authorization: 'Bearer cron-secret' } });
    expect((await (await GET(cronForce)).json()).skipped).toBe('done-today');
  });

  it('skips while another run holds the lock, and leaves that lock alone', async () => {
    kv.set('triage:run-lock', 'someone-else');
    expect((await (await GET(cron())).json()).skipped).toBe('locked');
    expect(collect).not.toHaveBeenCalled();
    expect(kv.get('triage:run-lock')).toBe('someone-else');
  });

  it('only releases a lock it still owns', async () => {
    analyze.mockImplementationOnce(async () => {
      kv.set('triage:run-lock', 'next-run'); // ours expired, another run took it
      return findings;
    });
    await GET(cron());
    expect(kv.get('triage:run-lock')).toBe('next-run');
  });

  it('reports a failed run as a 500, records a health error and releases the lock', async () => {
    collect.mockRejectedValueOnce(new Error('qbo down'));
    const res = await GET(cron());
    expect(res.status).toBe(500);
    expect(kv.has('triage:run-lock')).toBe(false);
    expect(recordFailure).toHaveBeenCalledWith('triage', 'triage failed: qbo down');
    expect(kv.has('triage:last-run')).toBe(false);
    expect(publishTriageItems).not.toHaveBeenCalled();
  });

  it('abandons a run past its budget unpublished', async () => {
    vi.useFakeTimers();
    try {
      mode.value = 'live';
      analyze.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = GET(cron());
      await vi.advanceTimersByTimeAsync(720_000);
      const res = await pending;
      expect(res.status).toBe(500);
      expect((await res.json()).message).toMatch(/720s budget/);
      expect(publishTriageItems).not.toHaveBeenCalled();
      expect(recordFailure).toHaveBeenCalledWith('triage', expect.stringMatching(/budget/));
      expect(kv.has('triage:run-lock')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a degraded run (LLM errors, blind email sweep) as a health error', async () => {
    findings.stats = { llmErrors: 3, emailSweepOk: 0, geminiCanaryOk: 1 };
    const body = await (await GET(cron())).json();
    expect(body.status).toBe('ok');
    expect(recordFailure).toHaveBeenCalledWith('triage', 'triage run degraded: 3 LLM errors, email sweep failed');
    expect(recordRun).toHaveBeenCalledWith('triage', { sent: 0, skipped: 0, errors: 3 });
  });
});
