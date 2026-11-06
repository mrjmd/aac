import { describe, it, expect, vi } from 'vitest';
import { countCondition, type ConditionRedis } from '@aac/shared-utils/health';
import { keys } from '@aac/shared-utils/redis';
import {
  CANARY_MAX_AGE_MIN,
  evaluateGemini,
  gatherGeminiSignals,
  runGeminiCanary,
  runWatchdogTick,
  type GeminiSignals,
  type WatchdogDeps,
  type WatchdogRedis,
} from '../src/index.js';

const NOW = new Date('2026-11-05T16:20:00Z');
const ago = (min: number, from = NOW) => new Date(from.getTime() - min * 60_000).toISOString();

const sig = (over: Partial<GeminiSignals> = {}): GeminiSignals => ({
  now: NOW,
  recent: { 'router.read_failed': 0, 'dispatch.classifier_rejected': 0 },
  canaryOkAt: ago(30),
  ...over,
});

describe('evaluateGemini', () => {
  it('is quiet when the canary passed recently and the live paths are clean', () => {
    expect(evaluateGemini(sig())?.down).toBe(false);
  });

  it('trips at 3 live-path failures in the hour (router + classifier combined), not at 2', () => {
    expect(evaluateGemini(sig({ recent: { 'router.read_failed': 1, 'dispatch.classifier_rejected': 1 } }))?.down).toBe(false);
    const c = evaluateGemini(sig({ recent: { 'router.read_failed': 2, 'dispatch.classifier_rejected': 1 } }))!;
    expect(c.down).toBe(true);
    expect(c.id).toBe('gemini-degraded');
    expect(c.impact).toContain('2 inbound router read failure(s) and 1 scheduling classifier failure(s)');
  });

  it('trips when the hourly canary has not passed for two runs', () => {
    expect(evaluateGemini(sig({ canaryOkAt: ago(CANARY_MAX_AGE_MIN - 5) }))?.down).toBe(false);
    const c = evaluateGemini(sig({ canaryOkAt: ago(CANARY_MAX_AGE_MIN + 5) }))!;
    expect(c.down).toBe(true);
    expect(c.since).toBe(ago(CANARY_MAX_AGE_MIN + 5));
  });

  it('has no verdict without counts and without a canary pass (fresh deploy)', () => {
    expect(evaluateGemini(sig({ recent: null, canaryOkAt: null }))).toBeNull();
    // Counts alone still decide.
    expect(evaluateGemini(sig({ canaryOkAt: null }))?.down).toBe(false);
  });
});

/** Hash + zset + string store that both countCondition (writer) and the watchdog (reader) use. */
function store() {
  const strings = new Map<string, unknown>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
  const redis: WatchdogRedis & ConditionRedis & { set(k: string, v: unknown): Promise<unknown> } = {
    get: async <T>(k: string) => (strings.has(k) ? (strings.get(k) as T) : null),
    set: async (k: string, v: unknown) => {
      strings.set(k, v);
      return 'OK';
    },
    hgetall: async <T extends Record<string, unknown>>(k: string) => (strings.get(k) as T) ?? null,
    hset: async (k: string, kv: Record<string, unknown>) => {
      strings.set(k, { ...((strings.get(k) as object) ?? {}), ...kv });
      return Object.keys(kv).length;
    },
    hdel: async (k: string, ...fields: string[]) => {
      const h = { ...((strings.get(k) as Record<string, unknown>) ?? {}) };
      for (const f of fields) delete h[f];
      strings.set(k, h);
      return fields.length;
    },
    hincrby: async () => 1,
    expire: async () => 1,
    zadd: async (k: string, ...m: Array<{ score: number; member: string }>) => {
      zsets.set(k, [...(zsets.get(k) ?? []), ...m]);
      return m.length;
    },
    zremrangebyscore: async (k: string, min: number, max: number) => {
      const before = zsets.get(k) ?? [];
      zsets.set(k, before.filter((x) => x.score < min || x.score > max));
      return 0;
    },
    zcount: async (k: string, min: number | string, max: number | string) =>
      (zsets.get(k) ?? []).filter((x) => x.score >= Number(min) && x.score <= Number(max)).length,
  };
  return { redis, strings };
}

describe('gatherGeminiSignals (reader contract with countCondition)', () => {
  it('counts the last hour of what countCondition wrote, not older', async () => {
    const { redis } = store();
    await countCondition(redis, 'router.read_failed', { now: new Date(ago(90)) });
    await countCondition(redis, 'router.read_failed', { by: 2, now: new Date(ago(10)) });
    await countCondition(redis, 'dispatch.classifier_rejected', { now: new Date(ago(5)) });
    const s = await gatherGeminiSignals(redis, NOW);
    expect(s.recent).toEqual({ 'router.read_failed': 2, 'dispatch.classifier_rejected': 1 });
  });

  it('reads no counts from a client without zcount', async () => {
    const { redis } = store();
    const { zcount: _omit, ...noZ } = redis;
    expect((await gatherGeminiSignals(noZ, NOW)).recent).toBeNull();
  });
});

describe('runGeminiCanary', () => {
  it('stamps the canary heartbeat on a pass', async () => {
    const { redis, strings } = store();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const r = await runGeminiCanary({ gemini: { extractEntities: async () => ({ firstName: 'Canary' }) }, redis });
    vi.useRealTimers();
    expect(r.ok).toBe(true);
    expect(strings.get(keys.heartbeat('gemini-canary'))).toBe(NOW.toISOString());
  });

  it('counts gemini.canary_failed on a throw, a wrong answer, or no key', async () => {
    for (const gemini of [
      { extractEntities: async () => Promise.reject(new Error('404 model retired')) },
      { extractEntities: async () => ({ firstName: 'Someone' }) },
      null,
    ]) {
      const { redis, strings } = store();
      const hincrby = vi.fn(async () => 1);
      const r = await runGeminiCanary({ gemini, redis: { ...redis, hincrby }, now: () => NOW });
      expect(r.ok).toBe(false);
      expect(hincrby).toHaveBeenCalledWith('health:conditions:2026-11-05', 'gemini.canary_failed', 1);
      expect(strings.has(keys.heartbeat('gemini-canary'))).toBe(false);
    }
  });
});

describe('runWatchdogTick with Gemini degraded', () => {
  it('texts after two ticks of 3+ live failures and once on recovery', async () => {
    const { redis } = store();
    // Every other pipe healthy.
    for (const [k, v] of Object.entries({
      [keys.webhookLast('quo')]: ago(300),
      [keys.cronLastRun('invoice-create')]: '2026-11-05T11:00:36Z',
      [keys.cronLastRun('job-reminders')]: '2026-11-05T12:00:26Z',
      [keys.cronLastRun('job-followups')]: '2026-11-05T13:00:29Z',
      [keys.cronLastRun('deal-reconcile')]: '2026-11-05T14:00:21Z',
      [keys.cronLastRun('qb-reconcile')]: ago(10),
      [keys.cronLastRun('sweep')]: ago(1),
      [keys.cronLastRun('inbound-tick')]: ago(1),
      [keys.cronLastRun('quote-email-tick')]: ago(1),
      [keys.cronLastRun('error-surface')]: ago(1),
      [keys.heartbeat('worker')]: ago(1),
      [keys.heartbeat('quote-drafter')]: ago(1),
      [keys.heartbeat('gemini-canary')]: ago(20),
    }))
      await redis.set(k, v);
    for (let i = 0; i < 3; i++) await countCondition(redis, 'router.read_failed', { now: new Date(ago(15)) });

    let t = NOW;
    const texts: string[] = [];
    const d: WatchdogDeps = {
      redis,
      now: () => t,
      quoNewestActivity: async () => null,
      middlewareHealth: async () => ({ ok: true, detail: '200' }),
      sms: async (x) => {
        texts.push(x);
      },
    };
    await runWatchdogTick(d);
    expect(texts).toEqual([]);
    t = new Date(NOW.getTime() + 5 * 60_000);
    const second = await runWatchdogTick(d);
    expect(second.texted).toEqual(['gemini-degraded']);
    expect(texts[0]).toMatch(/^⚠️ Gemini \(drafts, intake replies, scheduling\) failing\. 3 inbound router read failure\(s\).*Fix: /);

    // The failures age out of the hour, the canary keeps passing.
    t = new Date(NOW.getTime() + 50 * 60_000);
    await redis.set(keys.heartbeat('gemini-canary'), ago(5, t));
    await redis.set(keys.heartbeat('worker'), ago(1, t));
    await redis.set(keys.heartbeat('quote-drafter'), ago(1, t));
    await redis.set(keys.cronLastRun('qb-reconcile'), ago(1, t));
    const rec = await runWatchdogTick(d);
    expect(rec.recovered).toEqual(['gemini-degraded']);
    expect(texts[1]).toBe('✅ Recovered: Gemini (drafts, intake replies, scheduling) is back (was down since Thu 11:20 AM).');
  });
});
