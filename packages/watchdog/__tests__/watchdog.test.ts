import { describe, it, expect } from 'vitest';
import { keys } from '@aac/shared-utils/redis';
import { evaluate, runWatchdogTick, type Signals, type WatchdogDeps, type WatchdogRedis } from '../src/index.js';

const NOW = new Date('2026-11-05T16:20:00Z'); // 11:20am ET
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function healthy(over: Partial<Signals> = {}): Signals {
  return {
    now: NOW,
    quo: { newestActivityAt: ago(27), lastProcessedAt: ago(26.9) },
    crons: {
      'invoice-create': '2026-11-05T11:00:36Z',
      'job-reminders': '2026-11-05T12:00:26Z',
      'job-followups': '2026-11-05T13:00:29Z',
      'deal-reconcile': '2026-11-05T14:00:21Z',
      'qb-reconcile': ago(20),
    },
    heartbeats: { worker: ago(1), 'quote-drafter': ago(1) },
    middlewareHealth: { ok: true, detail: '200' },
    ...over,
  };
}
const downIds = (s: Signals) => evaluate(s).filter((c) => c.down).map((c) => c.id);

describe('evaluate', () => {
  it('is quiet on a healthy system (live values from 2026-11-05)', () => {
    expect(downIds(healthy())).toEqual([]);
  });

  it('flags the 10/19 class: Quo activity the middleware never processed', () => {
    expect(downIds(healthy({ quo: { newestActivityAt: ago(20), lastProcessedAt: ago(80) } }))).toEqual(['quo-pipe']);
  });

  it('gives a fresh event time to process, and stays quiet overnight with no activity', () => {
    expect(downIds(healthy({ quo: { newestActivityAt: ago(5), lastProcessedAt: ago(80) } }))).toEqual([]);
    expect(downIds(healthy({ quo: { newestActivityAt: null, lastProcessedAt: ago(600) } }))).toEqual([]);
  });

  it('never calls the pipe down because the Quo API itself errored', () => {
    expect(downIds(healthy({ quo: { error: '503' } }))).toEqual([]);
  });

  it('flags a daily cron only after its window plus grace', () => {
    const crons = { ...healthy().crons, 'job-reminders': '2026-11-04T12:00:20Z' };
    expect(downIds(healthy({ crons, now: new Date('2026-11-05T13:00:00Z') }))).not.toContain('cron:job-reminders');
    expect(downIds(healthy({ crons }))).toContain('cron:job-reminders');
  });

  it('flags stopped interval crons, dead workers and a failing health check', () => {
    const s = healthy({
      crons: { ...healthy().crons, 'qb-reconcile': ago(120) },
      heartbeats: { worker: ago(45), 'quote-drafter': null },
      middlewareHealth: { ok: false, detail: '500' },
    });
    expect(downIds(s).sort()).toEqual(['cron:qb-reconcile', 'heartbeat:quote-drafter', 'heartbeat:worker', 'middleware-health']);
  });
});

function memRedis(init: Record<string, unknown> = {}): WatchdogRedis & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(init));
  return {
    store,
    async get<T>(k: string) {
      return (store.get(k) as T) ?? null;
    },
    async set<T>(k: string, v: T) {
      store.set(k, v);
      return 'OK';
    },
    async hgetall<T extends Record<string, unknown>>(k: string) {
      return (store.get(k) as T) ?? null;
    },
    async hset<T>(k: string, kv: { [f: string]: T }) {
      store.set(k, { ...((store.get(k) as object) ?? {}), ...kv });
      return Object.keys(kv).length;
    },
    async hdel(k: string, ...fields: string[]) {
      const h = { ...((store.get(k) as Record<string, unknown>) ?? {}) };
      for (const f of fields) delete h[f];
      store.set(k, h);
      return fields.length;
    },
  };
}

function deps(redis: WatchdogRedis, at: () => Date, quo: { newest: string | null }): WatchdogDeps & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    redis,
    now: at,
    quoNewestActivity: async () => quo.newest,
    middlewareHealth: async () => ({ ok: true, detail: '200' }),
    sms: async (t) => {
      texts.push(t);
    },
  };
}

describe('runWatchdogTick', () => {
  const healthyRedis = () =>
    memRedis({
      [keys.webhookLast('quo')]: ago(300),
      [keys.cronLastRun('invoice-create')]: '2026-11-05T11:00:36Z',
      [keys.cronLastRun('job-reminders')]: '2026-11-05T12:00:26Z',
      [keys.cronLastRun('job-followups')]: '2026-11-05T13:00:29Z',
      [keys.cronLastRun('deal-reconcile')]: '2026-11-05T14:00:21Z',
      [keys.cronLastRun('qb-reconcile')]: ago(10),
      [keys.heartbeat('worker')]: ago(1),
      [keys.heartbeat('quote-drafter')]: ago(1),
    });

  it('texts once after two down ticks, reminds after 6h, and announces recovery once', async () => {
    const redis = healthyRedis();
    let t = NOW;
    const quo = { newest: ago(20) as string | null };
    const d = deps(redis, () => t, quo);

    await runWatchdogTick(d); // first sighting: no page for a single blip
    expect(d.texts).toHaveLength(0);
    t = new Date(NOW.getTime() + 5 * 60_000);
    const second = await runWatchdogTick(d);
    expect(second.texted).toEqual(['quo-pipe']);
    expect(d.texts[0]).toMatch(/^⚠️ Quo → middleware pipe DOWN since .*Fix: .*re-enable/);

    t = new Date(NOW.getTime() + 60 * 60_000);
    await runWatchdogTick(d);
    expect(d.texts).toHaveLength(1);
    // Everything else keeps beating through the outage.
    const beat = async () => {
      for (const k of [keys.heartbeat('worker'), keys.heartbeat('quote-drafter'), keys.cronLastRun('qb-reconcile')]) await redis.set(k, t.toISOString());
    };
    t = new Date(NOW.getTime() + 6.2 * 3_600_000);
    await beat();
    await runWatchdogTick(d);
    expect(d.texts[1]).toMatch(/^⚠️ STILL DOWN: /);

    await redis.set(keys.webhookLast('quo'), t.toISOString());
    const rec = await runWatchdogTick(d);
    expect(rec.recovered).toEqual(['quo-pipe']);
    expect(d.texts[2]).toMatch(/^✅ Recovered: Quo → middleware pipe is back/);
    expect(await redis.hgetall(keys.watchdogState)).toEqual({});
    expect(await redis.get(keys.heartbeat('watchdog'))).toBe(t.toISOString());
  });

  it('a blip that clears before the second tick never texts, even on recovery', async () => {
    const redis = healthyRedis();
    const quo = { newest: ago(20) as string | null };
    const d = deps(redis, () => NOW, quo);
    await runWatchdogTick(d);
    quo.newest = ago(400);
    await runWatchdogTick(d);
    expect(d.texts).toEqual([]);
  });
});
