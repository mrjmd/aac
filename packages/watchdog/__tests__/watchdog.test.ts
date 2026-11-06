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
      sweep: ago(4),
      'inbound-tick': ago(1),
      'quote-email-tick': ago(9),
      'error-surface': ago(6),
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

describe('evaluate: worker and agent crons', () => {
  it('flags each stopped worker interval cron and the agent error-surface by its own window', () => {
    const crons = { ...healthy().crons, sweep: ago(40), 'inbound-tick': ago(21), 'quote-email-tick': ago(55), 'error-surface': ago(26) };
    expect(downIds(healthy({ crons })).sort()).toEqual(['cron:error-surface', 'cron:inbound-tick', 'cron:quote-email-tick', 'cron:sweep']);
    const fresh = { ...healthy().crons, sweep: ago(30), 'inbound-tick': ago(19), 'quote-email-tick': ago(45), 'error-surface': ago(24) };
    expect(downIds(healthy({ crons: fresh }))).toEqual([]);
  });

  it('a stopped error-surface says alerts have stopped and points at the agent project', () => {
    const c = evaluate(healthy({ crons: { ...healthy().crons, 'error-surface': ago(60) } })).find((x) => x.id === 'cron:error-surface')!;
    expect(c.down).toBe(true);
    expect(c.impact).toMatch(/Error texts have stopped/);
    expect(c.fix).toMatch(/agent project/);
  });

  it('ignores a mode-gated daily job that is off or unset, however long since it ran', () => {
    const modes = { 'stale-quotes': 'off', triage: null, 'ads-conversions': 'garbage' };
    expect(downIds(healthy({ modes, modeOnSince: {} }))).toEqual([]);
  });

  it('flags a mode-gated daily job that is on and missed its slot plus grace', () => {
    const modes = { 'stale-quotes': 'live', triage: 'dry', 'ads-conversions': 'live' };
    const modeOnSince = { 'stale-quotes': '2026-11-01T00:00:00Z', triage: '2026-11-01T00:00:00Z', 'ads-conversions': '2026-11-01T00:00:00Z' };
    const crons = {
      ...healthy().crons,
      'stale-quotes': '2026-11-04T12:00:30Z',
      triage: '2026-11-04T13:10:00Z',
      'ads-conversions': '2026-11-05T11:00:40Z',
    };
    // 16:20 UTC: stale-quotes (12:00 + 90m) and triage (13:00 + 90m) are late; ads ran today.
    expect(downIds(healthy({ modes, modeOnSince, crons })).sort()).toEqual(['cron:stale-quotes', 'cron:triage']);
    // 14:00 UTC: stale-quotes is past 12:00 + 90m; triage's 13:00 + 90m hasn't passed yet.
    expect(downIds(healthy({ modes, modeOnSince, crons, now: new Date('2026-11-05T14:00:00Z') }))).toEqual(['cron:stale-quotes']);
    // 13:20 UTC: neither is late yet.
    expect(downIds(healthy({ modes, modeOnSince, crons, now: new Date('2026-11-05T13:20:00Z') }))).toEqual([]);
  });

  it('does not call a job late on the day it was switched on after its slot', () => {
    const modes = { triage: 'live' };
    expect(downIds(healthy({ modes, modeOnSince: { triage: '2026-11-05T15:00:00Z' } }))).toEqual([]);
    // First sighting (no stamp yet) counts as on since now.
    expect(downIds(healthy({ modes, modeOnSince: {} }))).toEqual([]);
    // Next day, past the slot, still never ran: late.
    const nextDay = new Date('2026-11-06T16:20:00Z');
    const crons = { ...healthy().crons, 'invoice-create': '2026-11-06T11:00:00Z', 'job-reminders': '2026-11-06T12:00:00Z', 'job-followups': '2026-11-06T13:00:00Z', 'deal-reconcile': '2026-11-06T14:00:00Z' };
    const fresh = Object.fromEntries(Object.entries(crons).map(([k, v]) => [k, ['qb-reconcile', 'sweep', 'inbound-tick', 'quote-email-tick', 'error-surface'].includes(k) ? '2026-11-06T16:15:00Z' : v]));
    expect(downIds(healthy({ now: nextDay, crons: fresh, heartbeats: { worker: '2026-11-06T16:19:00Z', 'quote-drafter': '2026-11-06T16:19:00Z' }, quo: { newestActivityAt: null, lastProcessedAt: null }, modes, modeOnSince: { triage: '2026-11-05T15:00:00Z' } }))).toEqual(['cron:triage']);
  });
});

describe('evaluate: quote drafter skip streaks', () => {
  const lockedFor = (ticks: number, lastMinAgo = 1) => ({ reason: 'locked' as const, since: ago(ticks), at: ago(lastMinAgo), ticks });

  it('flags a run lock held for 15 consecutive ticks, not 14', () => {
    expect(downIds(healthy({ quoteDrafterSkip: lockedFor(14) }))).toEqual([]);
    expect(downIds(healthy({ quoteDrafterSkip: lockedFor(15) }))).toEqual(['quote-drafter:locked']);
  });

  it('reports the lock instead of a stale heartbeat while it is held', () => {
    const s = healthy({ quoteDrafterSkip: lockedFor(25), heartbeats: { worker: ago(1), 'quote-drafter': ago(26) } });
    expect(downIds(s)).toEqual(['quote-drafter:locked']);
  });

  it('a streak whose last tick is old is not current: the stale heartbeat reports the dead tick', () => {
    const s = healthy({ quoteDrafterSkip: lockedFor(30, 25), heartbeats: { worker: ago(1), 'quote-drafter': ago(55) } });
    expect(downIds(s)).toEqual(['heartbeat:quote-drafter']);
  });

  it('flags a missing asset manifest from the first skipped tick', () => {
    const c = evaluate(healthy({ quoteDrafterSkip: { reason: 'no-assets', since: ago(3), at: ago(3), ticks: 1 } })).filter((x) => x.down);
    expect(c.map((x) => x.id)).toEqual(['quote-drafter:no-assets']);
    expect(c[0].fix).toMatch(/sync-assets/);
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
      [keys.cronLastRun('sweep')]: ago(4),
      [keys.cronLastRun('inbound-tick')]: ago(1),
      [keys.cronLastRun('quote-email-tick')]: ago(9),
      [keys.cronLastRun('error-surface')]: ago(6),
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
      const beats = [keys.heartbeat('worker'), keys.heartbeat('quote-drafter')];
      const crons = ['qb-reconcile', 'sweep', 'inbound-tick', 'quote-email-tick', 'error-surface'].map((j) => keys.cronLastRun(j));
      for (const k of [...beats, ...crons]) await redis.set(k, t.toISOString());
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

  it('remembers when a gated job was switched on and forgets it when switched off', async () => {
    const redis = healthyRedis();
    redis.store.set(keys.triageMode, 'live');
    const d = deps(redis, () => NOW, { newest: null });
    await runWatchdogTick({ ...d, env: { ADS_CONVERSIONS_MODE: 'dry' } });
    expect(await redis.hgetall(keys.watchdogModeOn)).toEqual({ triage: NOW.toISOString(), 'ads-conversions': NOW.toISOString() });
    redis.store.set(keys.triageMode, 'off');
    await runWatchdogTick({ ...d, now: () => new Date(NOW.getTime() + 5 * 60_000), env: { ADS_CONVERSIONS_MODE: 'dry' } });
    expect(await redis.hgetall(keys.watchdogModeOn)).toEqual({ 'ads-conversions': NOW.toISOString() });
    expect(d.texts).toEqual([]);
  });

  it('texts a stuck quote lock with its own recovery line', async () => {
    const redis = healthyRedis();
    let t = NOW;
    const d = deps(redis, () => t, { newest: null });
    const lock = (ticks: number) => redis.store.set(keys.quoteDrafterSkip, { reason: 'locked', since: ago(ticks), at: t.toISOString(), ticks });
    lock(15);
    await runWatchdogTick(d);
    t = new Date(NOW.getTime() + 5 * 60_000);
    lock(20);
    const second = await runWatchdogTick(d);
    expect(second.texted).toEqual(['quote-drafter:locked']);
    expect(d.texts[0]).toMatch(/Quote drafter stuck on its run lock/);
    redis.store.delete(keys.quoteDrafterSkip);
    await runWatchdogTick(d);
    expect(d.texts[1]).toMatch(/^✅ Recovered: Quote drafter run lock is free again/);
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
