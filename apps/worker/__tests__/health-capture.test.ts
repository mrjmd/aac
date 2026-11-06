/**
 * Every worker route records its failures in `health:errors` (source
 * `worker:<route>`, through the real lib/health.ts + @aac/shared-utils/health
 * against an in-memory Upstash stand-in), and the cron routes without a
 * heartbeat stamp `cron:<route>:last-run`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Health Redis (lib/health.ts builds its own @upstash/redis client) ──
const hs = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const list: string[] = [];
  const state = { down: false };
  const guard = () => {
    if (state.down) throw new Error('ECONNREFUSED redis');
  };
  const client = {
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean; ex?: number }) => {
      guard();
      if (opts?.nx && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    }),
    lpush: vi.fn(async (_key: string, ...els: string[]) => {
      guard();
      return list.unshift(...els);
    }),
    ltrim: vi.fn(async () => {
      guard();
      return 'OK';
    }),
  };
  return { strings, list, state, client };
});
vi.mock('@upstash/redis', () => ({ Redis: vi.fn(() => hs.client) }));

// ── Route deps ──
const workerRedis = vi.hoisted(() => {
  const kv = new Map<string, unknown>();
  return {
    kv,
    set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => {
      if (o?.nx && kv.has(k)) return null;
      kv.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    del: vi.fn(async (k: string) => Number(kv.delete(k))),
    hget: vi.fn(async (k: string, f: string) => (kv.get(k) as Record<string, unknown> | undefined)?.[f] ?? null),
    eval: vi.fn(async (_script: string, ks: string[], args: string[]) => {
      if (kv.get(ks[0]) !== args[0]) return 0;
      kv.delete(ks[0]);
      return 1;
    }),
  };
});
const getWorkerDeps = vi.hoisted(() =>
  vi.fn(() => ({
    deps: { state: { getFirstRunAt: async () => '2026-10-19T11:00:00Z', setFirstRunAt: async () => {} }, quo: {}, gemini: {} },
    redis: workerRedis,
  })),
);
vi.mock('../lib/deps.js', () => ({ getWorkerDeps }));

const drafts = vi.hoisted(() => ({
  drainFollowupQueue: vi.fn(async (): Promise<Array<{ outcome: string }>> => []),
  drainIntakeDue: vi.fn(async (): Promise<Array<{ outcome: string }>> => []),
  dropIntakeDue: vi.fn(async () => 0),
  sweepFollowups: vi.fn(async (): Promise<Array<{ outcome: string }>> => [{ outcome: 'drafted' }, { outcome: 'no-quo-contact' }]),
  sweepIntake: vi.fn(async (): Promise<Array<{ outcome: string }>> => []),
  processFollowupById: vi.fn(async (): Promise<{ outcome: string } | null> => ({ outcome: 'drafted' })),
}));
vi.mock('@aac/message-drafts', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...drafts }));

const router = vi.hoisted(() => ({
  runInboundTick: vi.fn(async (): Promise<{ mode: string; due: number; entries: Array<Record<string, unknown>> }> => ({
    mode: 'shadow',
    due: 0,
    entries: [],
  })),
  sweepInbound: vi.fn(async () => []),
}));
vi.mock('@aac/inbound-router', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...router }));

const drafter = vi.hoisted(() => ({
  runTick: vi.fn(async (): Promise<Record<string, unknown>> => ({ mode: 'live', drained: 0, due: 0, settling: 0, drafted: 0, records: [] })),
  loadAssets: vi.fn(async (): Promise<object | null> => ({ rulesetText: 'x', exemplarLibrary: [] })),
  prepareRun: vi.fn(async () => ({})),
  loadFieldChannel: vi.fn(async () => null),
  draftOne: vi.fn(async (): Promise<Record<string, unknown>> => ({ phone: '+15085551234', outcome: 'created' })),
  pollQuoteEmails: vi.fn(async () => ({ openQuotes: 3, scanned: 5, enqueued: 1 })),
  resolveMode: vi.fn(async () => 'live'),
}));
vi.mock('@aac/quote-drafter', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...drafter }));
vi.mock('../lib/quote-deps.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getQuoteDeps: vi.fn(() => ({ redis: workerRedis })),
}));
vi.mock('@aac/api-clients/gmail', () => ({ GmailClient: vi.fn(() => ({})) }));

const staleRun = vi.hoisted(() =>
  vi.fn(async () => ({ partial: false, pendingInScope: 2, queue: { toSend: [1], waiting: [], flags: [], skipped: [1] }, awaiting: [] })),
);
const staleMode = vi.hoisted(() => vi.fn(async () => 'dry'));
vi.mock('@aac/stale-quotes', () => ({ runStaleQuotes: staleRun }));
vi.mock('../lib/stale-quotes-deps.js', () => ({ getStaleQuoteDeps: () => ({}), staleQuotesMode: staleMode }));

const adsRun = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown>> => ({ mode: 'dry', uploaded: 0, failed: [] })));
vi.mock('@aac/ads-conversions', () => ({ runAdsConversions: adsRun }));
vi.mock('../lib/ads-deps.js', () => ({ getAdsDeps: () => ({}), adsMode: () => 'dry' }));

const triage = vi.hoisted(() => ({
  collect: vi.fn(async () => ({})),
  analyze: vi.fn(async (): Promise<Record<string, unknown>> => ({
    generatedAt: '2026-11-05T13:05:00.000Z',
    findings: [{ section: 'conversation' }],
    stats: { llmErrors: 0, emailSweepOk: 1, geminiCanaryOk: 1 },
  })),
  triageCandidates: vi.fn(() => [{ key: 'a', detector: 'L1' }]),
  publishTriageItems: vi.fn(async () => undefined),
}));
const triageMode = vi.hoisted(() => vi.fn(async () => 'dry'));
vi.mock('@aac/triage', () => triage);
vi.mock('../lib/triage-deps.js', () => ({
  missingTriageEnv: () => null,
  triageMode,
  getTriageDeps: () => ({
    redis: workerRedis,
    collect: { now: () => Date.now() },
    analyze: { now: () => Date.now() },
    loadStaleLists: async () => ({ queue: null, awaiting: null }),
  }),
}));

const watchdogTick = vi.hoisted(() => vi.fn(async () => ({ down: [], texted: [], recovered: [] })));
vi.mock('@aac/watchdog', () => ({ runWatchdogTick: watchdogTick }));
vi.mock('../lib/watchdog-deps.js', () => ({ getWatchdogDeps: () => ({}) }));

import { GET as tick } from '../api/tick.js';
import { GET as sweep } from '../api/sweep.js';
import { GET as inboundTick } from '../api/inbound-tick.js';
import { GET as quoteTick } from '../api/quote-tick.js';
import { POST as quoteDraft } from '../api/quote-draft.js';
import { GET as quoteEmailTick } from '../api/quote-email-tick.js';
import { GET as staleQuotes } from '../api/stale-quotes.js';
import { GET as triageRoute } from '../api/triage.js';
import { GET as adsConversions } from '../api/ads-conversions.js';
import { POST as draftFollowup } from '../api/draft-followup.js';
import { GET as watchdog } from '../api/watchdog.js';

const cron = () => new Request('https://worker.test/api/x', { headers: { authorization: 'Bearer cron-secret' } });
const post = (body: unknown) =>
  new Request('https://worker.test/api/x', {
    method: 'POST',
    headers: { 'x-worker-secret': 'worker-secret' },
    body: JSON.stringify(body),
  });

interface Entry {
  source: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}
const errors = (): Entry[] => hs.list.map((e) => JSON.parse(e) as Entry);
const lastRun = (route: string) => hs.strings.get(`cron:${route}:last-run`) ?? null;
const result = (route: string) => {
  const key = [...hs.strings.keys()].find((k) => k.startsWith(`cron:${route}:`) && k.endsWith(':result'));
  return key ? JSON.parse(hs.strings.get(key)!) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  hs.strings.clear();
  hs.list.length = 0;
  hs.state.down = false;
  workerRedis.kv.clear();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('top-level failures land in health:errors as worker:<route>', () => {
  const cases: Array<[string, () => void, () => Promise<Response>]> = [
    ['tick', () => drafts.drainFollowupQueue.mockRejectedValueOnce(new Error('qbo 503')), () => tick(cron())],
    ['sweep', () => drafts.sweepFollowups.mockRejectedValueOnce(new Error('qbo 503')), () => sweep(cron())],
    ['inbound-tick', () => router.runInboundTick.mockRejectedValueOnce(new Error('qbo 503')), () => inboundTick(cron())],
    ['quote-tick', () => drafter.runTick.mockRejectedValueOnce(new Error('qbo 503')), () => quoteTick(cron())],
    ['quote-draft', () => drafter.prepareRun.mockRejectedValueOnce(new Error('qbo 503')), () => quoteDraft(post({ phone: '+15085551234' }))],
    ['quote-email-tick', () => drafter.pollQuoteEmails.mockRejectedValueOnce(new Error('qbo 503')), () => quoteEmailTick(cron())],
    ['stale-quotes', () => staleRun.mockRejectedValueOnce(new Error('qbo 503')), () => staleQuotes(cron())],
    ['triage', () => triage.collect.mockRejectedValueOnce(new Error('qbo 503')), () => triageRoute(cron())],
    ['ads-conversions', () => adsRun.mockRejectedValueOnce(new Error('qbo 503')), () => adsConversions(cron())],
    ['draft-followup', () => drafts.processFollowupById.mockRejectedValueOnce(new Error('qbo 503')), () => draftFollowup(post({ estimateId: '9', sync: true }))],
    ['watchdog', () => watchdogTick.mockRejectedValueOnce(new Error('qbo 503')), () => watchdog(cron())],
  ];

  it.each(cases)('%s: 500 and one entry', async (route, fail, call) => {
    fail();
    const res = await call();
    expect(res.status).toBe(500);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ source: `worker:${route}` });
    expect(errors()[0].message).toContain('qbo 503');
  });

  it('records deps that fail to build (moved inside the try / guarded)', async () => {
    const noEnv = () => {
      throw new Error('Missing env: QUO_API_KEY');
    };
    for (const [route, call] of [
      ['tick', () => tick(cron())],
      ['sweep', () => sweep(cron())],
      ['inbound-tick', () => inboundTick(cron())],
      ['draft-followup', () => draftFollowup(post({ estimateId: '9' }))],
    ] as const) {
      getWorkerDeps.mockImplementationOnce(noEnv);
      expect((await call()).status, route).toBe(500);
      expect(errors()[0], route).toMatchObject({ source: `worker:${route}`, message: expect.stringContaining('Missing env') });
    }
  });

  it('stale-quotes: a Redis read before its try is guarded, recorded and answered 500 JSON', async () => {
    staleMode.mockRejectedValueOnce(new Error('upstash 500'));
    const res = await staleQuotes(cron());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 'error', message: 'upstash 500' });
    expect(errors()[0]).toMatchObject({ source: 'worker:stale-quotes', message: 'stale-quotes failed: upstash 500' });
  });

  it('triage: a Redis read before its try is guarded, recorded and answered 500 JSON', async () => {
    triageMode.mockRejectedValueOnce(new Error('upstash 500'));
    const res = await triageRoute(cron());
    expect(res.status).toBe(500);
    expect(errors()[0]).toMatchObject({ source: 'worker:triage', message: 'triage failed: upstash 500' });
  });

  it('draft-followup: a deferred (async) failure is recorded too', async () => {
    drafts.processFollowupById.mockRejectedValueOnce(new Error('gemini down'));
    expect((await draftFollowup(post({ estimateId: '42' }))).status).toBe(202);
    await vi.waitFor(() => expect(errors()).toHaveLength(1));
    expect(errors()[0]).toMatchObject({ source: 'worker:draft-followup', details: { estimateId: '42' } });
  });

  it('the scope-less Gmail token stays a logged skip, not an error', async () => {
    drafter.pollQuoteEmails.mockRejectedValueOnce(new Error('403 insufficient scope'));
    expect(await (await quoteEmailTick(cron())).json()).toMatchObject({ skipped: 'no-gmail-scope' });
    expect(errors()).toEqual([]);
  });
});

describe('failures packages swallow into a result', () => {
  it('inbound-tick: failed bursts', async () => {
    router.runInboundTick.mockResolvedValueOnce({
      mode: 'shadow',
      due: 3,
      entries: [
        { at: 'x', phone: '+15085550001', outcome: 'failed', detail: 'gemini: 429' },
        { at: 'x', phone: '+15085550002', outcome: 'decided' },
      ],
    });
    expect((await inboundTick(cron())).status).toBe(200);
    expect(errors()).toEqual([
      expect.objectContaining({
        source: 'worker:inbound-tick',
        message: 'inbound router: 1 burst(s) failed',
        details: { failed: [{ phone: '+15085550001', detail: 'gemini: 429' }] },
      }),
    ]);
    expect(result('inbound-tick')).toEqual({ sent: 1, skipped: 1, errors: 1 });
  });

  it('quote-tick: failed drafts and a missing asset manifest', async () => {
    drafter.runTick.mockResolvedValueOnce({
      mode: 'live', drained: 1, due: 1, settling: 0, drafted: 0,
      records: [{ phone: '+15085550003', trigger: 'T1', record: { outcome: 'failed', detail: 'validation: no lines' } }],
    });
    expect((await quoteTick(cron())).status).toBe(200);
    expect(errors()[0]).toMatchObject({
      source: 'worker:quote-tick',
      message: 'quote drafter: 1 draft(s) failed',
      details: { failed: [{ phone: '+15085550003', trigger: 'T1', detail: 'validation: no lines' }] },
    });

    hs.strings.clear(); // new throttle window
    drafter.runTick.mockResolvedValueOnce({ mode: 'live', skipped: 'no-assets', drained: 0, due: 0, settling: 0, drafted: 0, records: [] });
    await quoteTick(cron());
    expect(errors()[0].message).toContain('no asset manifest');
  });

  it('quote-draft: a failed manual draft and a missing manifest', async () => {
    drafter.draftOne.mockResolvedValueOnce({ phone: '+15085551234', outcome: 'failed', detail: 'gate unparseable' });
    expect((await quoteDraft(post({ phone: '+15085551234' }))).status).toBe(200);
    expect(errors()[0]).toMatchObject({ source: 'worker:quote-draft', message: 'manual draft failed: gate unparseable' });

    hs.strings.clear();
    drafter.loadAssets.mockResolvedValueOnce(null);
    expect((await quoteDraft(post({ phone: '+15085551234' }))).status).toBe(409);
    expect(errors()[0].message).toContain('no asset manifest');
  });

  it('ads-conversions: rejected uploads', async () => {
    adsRun.mockResolvedValueOnce({ mode: 'live', uploaded: 2, failed: [{ orderId: 'o1', error: 'INVALID_GCLID' }] });
    expect((await adsConversions(cron())).status).toBe(200);
    expect(errors()[0]).toMatchObject({
      source: 'worker:ads-conversions',
      message: 'ads conversions: 1 upload(s) failed',
      details: { mode: 'dry', failed: [{ orderId: 'o1', error: 'INVALID_GCLID' }] },
    });
  });

  it('triage: a run that finished blind (LLM errors, Gemini canary)', async () => {
    triage.analyze.mockResolvedValueOnce({
      generatedAt: '2026-11-05T13:05:00.000Z',
      findings: [],
      stats: { llmErrors: 2, emailSweepOk: 1, geminiCanaryOk: 0 },
    });
    expect((await triageRoute(cron())).status).toBe(200);
    expect(errors()[0]).toMatchObject({ source: 'worker:triage', message: 'triage run degraded: 2 LLM errors, Gemini canary failed' });
    expect(result('triage')).toEqual({ sent: 0, skipped: 0, errors: 2 });
  });

  it('a clean run records nothing', async () => {
    await tick(cron());
    await quoteTick(cron());
    await adsConversions(cron());
    await quoteDraft(post({ phone: '+15085551234' }));
    expect(errors()).toEqual([]);
  });
});

describe('last-run stamps (routes without a heartbeat)', () => {
  it('sweep, inbound-tick, quote-email-tick, stale-quotes and triage stamp cron:<route>:last-run with counts', async () => {
    await sweep(cron());
    await inboundTick(cron());
    await quoteEmailTick(cron());
    await staleQuotes(cron());
    await triageRoute(cron());
    for (const route of ['sweep', 'inbound-tick', 'quote-email-tick', 'stale-quotes', 'triage']) {
      expect(Number.isNaN(Date.parse(lastRun(route) ?? '')), route).toBe(false);
    }
    expect(result('sweep')).toEqual({ sent: 1, skipped: 1, errors: 0 });
    expect(result('quote-email-tick')).toEqual({ sent: 1, skipped: 4, errors: 0 });
    expect(result('stale-quotes')).toEqual({ sent: 1, skipped: 1, errors: 0 });
    expect(result('triage')).toEqual({ sent: 0, skipped: 0, errors: 0 });
  });

  it('a failed or skipped run does not stamp', async () => {
    drafts.sweepFollowups.mockRejectedValueOnce(new Error('x'));
    await sweep(cron());
    staleMode.mockResolvedValueOnce('off');
    await staleQuotes(cron());
    triageMode.mockResolvedValueOnce('off');
    await triageRoute(cron());
    expect(lastRun('triage')).toBeNull();
    expect(lastRun('sweep')).toBeNull();
    expect(lastRun('stale-quotes')).toBeNull();
  });

  it('tick and quote-tick keep their heartbeats on the worker client', async () => {
    await tick(cron());
    await quoteTick(cron());
    expect(workerRedis.set).toHaveBeenCalledWith('health:worker:ts', expect.any(String));
    expect(workerRedis.set).toHaveBeenCalledWith('health:quote-drafter:ts', expect.any(String));
  });
});

describe('heartbeats mean work happened', () => {
  const skip = () => workerRedis.kv.get('quote-drafter:skip') as { reason: string; ticks: number; since: string } | undefined;
  const beat = () => workerRedis.set.mock.calls.some((c) => c[0] === 'health:quote-drafter:ts');

  it('quote-tick: a locked tick skips the heartbeat and extends the lock streak; a tick that runs clears it', async () => {
    drafter.runTick.mockResolvedValue({ mode: 'live', skipped: 'locked', drained: 0, due: 0, settling: 0, drafted: 0, records: [] });
    try {
      await quoteTick(cron());
      await quoteTick(cron());
      await quoteTick(cron());
    } finally {
      drafter.runTick.mockReset();
      drafter.runTick.mockResolvedValue({ mode: 'live', drained: 0, due: 0, settling: 0, drafted: 0, records: [] });
    }
    expect(beat()).toBe(false);
    expect(skip()).toMatchObject({ reason: 'locked', ticks: 3 });
    await quoteTick(cron());
    expect(beat()).toBe(true);
    expect(skip()).toBeUndefined();
  });

  it('quote-tick: no-assets survives idle ticks until the manifest is back', async () => {
    drafter.runTick.mockResolvedValueOnce({ mode: 'live', skipped: 'no-assets', drained: 1, due: 1, settling: 0, drafted: 0, records: [] });
    await quoteTick(cron());
    expect(skip()).toMatchObject({ reason: 'no-assets', ticks: 1 });
    expect(beat()).toBe(false);
    await quoteTick(cron()); // idle: never loads the manifest
    expect(skip()).toMatchObject({ reason: 'no-assets' });
    workerRedis.kv.set('quote-drafter:assets', { ruleset: 'https://blob/ruleset.md' });
    await quoteTick(cron());
    expect(skip()).toBeUndefined();
  });

  it('quote-tick: mode off clears any streak and writes no heartbeat', async () => {
    workerRedis.kv.set('quote-drafter:skip', { reason: 'locked', since: 'x', at: 'x', ticks: 9 });
    drafter.runTick.mockResolvedValueOnce({ mode: 'off', skipped: 'off', drained: 0, due: 0, settling: 0, drafted: 0, records: [] });
    await quoteTick(cron());
    expect(skip()).toBeUndefined();
    expect(beat()).toBe(false);
  });

  it('inbound-tick: a tick whose every read failed does not stamp', async () => {
    router.runInboundTick.mockResolvedValueOnce({
      mode: 'live',
      due: 2,
      entries: [
        { at: 'x', phone: '+15085550001', outcome: 'failed', detail: 'gemini: 404' },
        { at: 'x', phone: '+15085550002', outcome: 'failed', detail: 'gemini: 404' },
      ],
    });
    expect((await inboundTick(cron())).status).toBe(200);
    expect(lastRun('inbound-tick')).toBeNull();
    expect(errors()[0].source).toBe('worker:inbound-tick');
    await inboundTick(cron()); // idle tick: the router is reading fine
    expect(lastRun('inbound-tick')).not.toBeNull();
  });
});

describe('throttle and outage', () => {
  it('a failure repeating every minute is recorded once per window', async () => {
    drafts.drainFollowupQueue.mockRejectedValue(new Error('qbo 503'));
    try {
      await tick(cron());
      await tick(cron());
      await tick(cron());
    } finally {
      drafts.drainFollowupQueue.mockReset();
      drafts.drainFollowupQueue.mockResolvedValue([]);
    }
    expect(errors()).toHaveLength(1);
    expect(hs.client.set).toHaveBeenCalledWith('health:errors:throttle:worker:tick', expect.any(String), { nx: true, ex: 600 });
  });

  it('with the health Redis down the route still answers its own status', async () => {
    hs.state.down = true;
    drafts.sweepFollowups.mockRejectedValueOnce(new Error('qbo 503'));
    const res = await sweep(cron());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 'error', message: 'qbo 503' });
    expect((await tick(cron())).status).toBe(200);
  });
});
