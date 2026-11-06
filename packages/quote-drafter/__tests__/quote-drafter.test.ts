import { describe, it, expect, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import type { OpenQuoteEntry } from '@aac/shared-utils/types';
import { classify, routerOwnsEvent, T2_DEDUPE_H, T4_DEDUPE_H, type TriggerEvent, type DrafterDeps } from '../src/types.js';
import { confirmNextDocNumber, draftOne, type DraftOneOptions, type RunContext } from '../src/drafter.js';
import { DEDUPE_PRUNE_MS, enqueueRoutedQuote, releaseRunLock, runTick, resolveVisitCustomers, RUN_LOCK_TTL_MS } from '../src/trigger.js';
import { loadAssets, clearAssetCache } from '../src/assets.js';
import { parseGateVerdict, buildScopeGatePrompt } from '../src/gate.js';
import {
  getOpenQuote,
  listOpenQuotes,
  syncOpenQuoteIndex,
  upsertOpenQuote,
} from '../src/open-quotes.js';
import { pollQuoteEmails } from '../src/email-poll.js';

// ── tiny in-memory Redis covering the subset the package uses ──────────

class MiniRedis {
  kv = new Map<string, unknown>();
  hashes = new Map<string, Map<string, unknown>>();
  lists = new Map<string, unknown[]>();
  zsets = new Map<string, Map<string, number>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown, opts?: { nx?: boolean; px?: number }): Promise<string | null> {
    if (opts?.nx && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
  /** Only the run lock's compare-and-delete script is supported. */
  async eval(script: string, keys: string[], args: string[]): Promise<number> {
    if (!script.includes('redis.call("get", KEYS[1]) == ARGV[1]')) throw new Error('unsupported script');
    if (this.kv.get(keys[0]) !== args[0]) return 0;
    this.kv.delete(keys[0]);
    return 1;
  }
  async rpop<T>(key: string): Promise<T | null> {
    const list = this.lists.get(key) ?? [];
    return (list.pop() as T) ?? null;
  }
  async lpush(key: string, ...values: unknown[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }
  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    const raw = this.hashes.get(key)?.get(field);
    if (raw === undefined) return null;
    // Upstash auto-deserializes JSON strings
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as T;
      }
    }
    return raw as T;
  }
  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const h = this.hashes.get(key) ?? new Map();
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
    this.hashes.set(key, h);
    return Object.keys(fields).length;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.hashes.get(key);
    let n = 0;
    for (const f of fields) if (h?.delete(f)) n++;
    return n;
  }
  async hgetall(key: string): Promise<Record<string, unknown> | null> {
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries(h.entries());
  }
  async zadd(
    key: string,
    optsOrMember: { gt?: boolean } | { score: number; member: string },
    maybeMember?: { score: number; member: string },
  ): Promise<number> {
    const opts: { gt?: boolean } = maybeMember ? optsOrMember : {};
    const member = maybeMember ?? (optsOrMember as { score: number; member: string });
    const z = this.zsets.get(key) ?? new Map<string, number>();
    const prev = z.get(member.member);
    if (opts.gt && prev !== undefined && prev >= member.score) {
      this.zsets.set(key, z);
      return 0;
    }
    z.set(member.member, member.score);
    this.zsets.set(key, z);
    return prev === undefined ? 1 : 0;
  }
  async zrange<T>(key: string, min: number, max: number, _opts: { byScore: true }): Promise<T> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    const members = [...z.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
    return members as T;
  }
  async zrem(key: string, member: string): Promise<number> {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }
  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}): {
  deps: DrafterDeps;
  redis: MiniRedis;
  logs: string[];
} {
  const redis = new MiniRedis();
  const logs: string[] = [];
  const throwingGemini = {
    generateContent: vi.fn().mockRejectedValue(new Error('gemini should not be called')),
    embedContent: vi.fn().mockRejectedValue(new Error('gemini should not be called')),
  };
  const deps = {
    redis: redis as unknown as Redis,
    qb: {
      findCustomerByPhone: vi.fn().mockResolvedValue(null),
      searchCustomerByName: vi.fn().mockResolvedValue(null),
      getEstimatesByCustomer: vi.fn().mockResolvedValue([]),
      listItems: vi.fn().mockResolvedValue([]),
      listRecentEstimates: vi.fn().mockResolvedValue([]),
      listAllCustomers: vi.fn().mockResolvedValue([]),
      createCustomer: vi.fn(),
      createEstimate: vi.fn(),
      replaceEstimateLines: vi.fn(),
    },
    quo: {
      listMessages: vi.fn().mockResolvedValue({ data: [] }),
      listCalls: vi.fn().mockResolvedValue({ data: [] }),
      findContactByPhone: vi.fn().mockResolvedValue(null),
      findContactByExternalId: vi.fn().mockResolvedValue(null),
      createContactNote: vi.fn(),
      downloadMessageMedia: vi.fn(),
      getCallTranscript: vi.fn(),
      getCallVoicemail: vi.fn().mockResolvedValue(null),
    },
    gemini: throwingGemini,
    calendar: null,
    drive: null,
    log: (l: string) => logs.push(l),
    now: () => new Date('2026-10-21T16:00:00Z').getTime(),
    ...overrides,
  } as unknown as DrafterDeps;
  return { deps, redis, logs };
}

function ev(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    phone: '+15083611747',
    direction: 'incoming',
    at: '2026-10-21T15:30:00Z',
    hasMedia: false,
    snippet: 'hi',
    ...overrides,
  };
}

const RUN: RunContext = {
  items: [],
  itemNames: ['Crack Repair'],
  recentEstimates: [],
  library: new Map(),
  today: '2026-10-21',
  nextDocNumber: 1600,
};

const ASSETS = { rulesetText: 'SECTION 0', exemplarLibrary: [] };

function draftOpts(overrides: Partial<DraftOneOptions> = {}): DraftOneOptions {
  return {
    finding: { phone: '+15083611747', customer: null, title: 'TRIGGER T3: test' },
    run: { ...RUN },
    assets: ASSETS,
    fieldChannel: null,
    dryRun: false,
    hasNewInbound: true,
    ...overrides,
  };
}

// ── classification (incl. the 10/21 post-send guard) ───────────────────

describe('classify', () => {
  it('T1 on inbound photos', () => {
    const v = classify([ev({ hasMedia: true })]);
    expect(v).toEqual({ trigger: 'T1', why: '1 inbound photo message(s)' });
  });

  it('T3 on an outbound forward-looking quote promise', () => {
    const v = classify([ev({ direction: 'outgoing', snippet: "We'll get you a quote tomorrow" })]);
    expect(v?.trigger).toBe('T3');
  });

  it('does NOT fire T3 on post-send language (John Skinner 10/21)', () => {
    expect(classify([ev({ direction: 'outgoing', snippet: 'I just sent that quote over — let me know if you have questions' })])).toBeNull();
    expect(classify([ev({ direction: 'outgoing', snippet: 'Just emailed the estimate to you' })])).toBeNull();
    expect(classify([ev({ direction: 'outgoing', snippet: 'Your quote is on its way' })])).toBeNull();
  });

  it('does not trigger on inbound text without media', () => {
    expect(classify([ev({ snippet: 'can you send me a quote?' })])).toBeNull();
  });
});

// ── drafter guards ─────────────────────────────────────────────────────

describe('draftOne guards', () => {
  it('resolves the customer by phone before any name logic', async () => {
    const { deps } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '2281',
      DisplayName: 'John Skinner',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '2826', SyncToken: '3', DocNumber: '1562', TxnStatus: 'Pending', TxnDate: '2026-10-20' },
    ]);
    const record = await draftOne(deps, draftOpts({ skipIfRecentEstimateDays: 30 }));
    expect(record.outcome).toBe('skipped');
    expect(record.detail).toContain('#1562');
    expect(record.customer).toBe('John Skinner');
    expect(deps.qb.searchCustomerByName).not.toHaveBeenCalled();
    expect(deps.qb.createCustomer).not.toHaveBeenCalled();
  });

  it('skips a bot-owned pending draft when there is no new inbound content', async () => {
    const { deps, redis } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '2281',
      DisplayName: 'John Skinner',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        Id: '2826',
        SyncToken: '0',
        DocNumber: '1562',
        TxnStatus: 'Pending',
        PrivateNote: 'BOT DRAFT — REVIEW BEFORE SENDING',
        CustomerMemo: { value: 'BOT DRAFT — REVIEW BEFORE SENDING' },
        Line: [{ Amount: 1, DetailType: 'SalesItemLineDetail', Description: 'BOT DRAFT — REVIEW BEFORE SENDING' }],
      },
    ]);
    await redis.set(keys.quoteDraftSyncToken('2826'), '0');
    const record = await draftOne(deps, draftOpts({ hasNewInbound: false }));
    expect(record.outcome).toBe('skipped');
    expect(record.detail).toContain('no new inbound');
    expect(deps.quo.listMessages).not.toHaveBeenCalled();
    expect(deps.gemini.generateContent).not.toHaveBeenCalled();
  });

  it('never touches a human-owned bot draft', async () => {
    const { deps, redis } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '2281',
      DisplayName: 'John Skinner',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        Id: '2826',
        SyncToken: '5',
        DocNumber: '1562',
        TxnStatus: 'Pending',
        PrivateNote: 'BOT DRAFT — REVIEW BEFORE SENDING',
        Line: [{ Amount: 1, DetailType: 'SalesItemLineDetail', Description: 'BOT DRAFT — REVIEW BEFORE SENDING' }],
      },
    ]);
    await redis.set(keys.quoteDraftSyncToken('2826'), '2'); // owner bumped it 2→5
    const record = await draftOne(deps, draftOpts());
    expect(record.outcome).toBe('skipped');
    expect(record.detail).toContain('human-owned');
  });

  it('defers creation when no name exists anywhere yet', async () => {
    const { deps } = makeDeps();
    (deps.quo.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ direction: 'incoming', createdAt: '2026-10-21T15:00:00Z', text: 'hello', media: [] }],
    });
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        lines: [{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }],
        confidence: 'high',
        needsSiteVisit: false,
        reasoning: 'r',
        scopeAccounting: [],
        openQuestions: [],
      }),
    );
    const record = await draftOne(
      deps,
      draftOpts({ run: { ...RUN, items: [{ Id: '1', Name: 'Crack Repair' }] as RunContext['items'] } }),
    );
    expect(record.outcome).toBe('skipped');
    expect(record.detail).toContain('no name yet');
    expect(deps.qb.createCustomer).not.toHaveBeenCalled();
  });
});

describe('draftOne decline rules (one decline source, inbound router phase 2)', () => {
  it('drafts with the /referrals rules and posts a decline naming the referral, never touching QBO', async () => {
    const { deps, redis } = makeDeps();
    await redis.hset(keys.canHelpRules, {
      'leaking-block': { id: 'leaking-block', kind: 'decline', text: 'Leaking cinder block walls', referralIds: ['air-guardian'], since: '2026-01-01' },
    });
    await redis.hset(keys.canHelpReferrals, {
      'air-guardian': { id: 'air-guardian', name: 'Air Guardian', phone: '(508) 355-0044', sends: 'Exterior waterproofing' },
    });
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ Id: '9', DisplayName: 'Sean Test' });
    (deps.quo.findContactByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (deps.quo.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ direction: 'incoming', createdAt: '2026-10-21T15:00:00Z', text: 'block bulkhead leaks, can you seal it?', media: [] }],
    });
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        lines: [],
        scope_accounting: [{
          request: 'seal the block bulkhead',
          quoted_item: null,
          reason: 'leaking cinder block',
          suggested_reply: 'Inside injection cannot stop water in hollow block; Air Guardian at (508) 355-0044 can help.',
        }],
        confidence: 'high',
        needs_site_visit: false,
        reasoning: 'r',
        open_questions: [],
      }),
    );
    const record = await draftOne(deps, draftOpts());
    expect(record.outcome).toBe('declined');
    const opts = (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][1] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain("WE CAN'T HELP WITH");
    expect(opts.systemPrompt).toContain('Leaking cinder block walls → refer: Air Guardian (508) 355-0044');
    expect(opts.systemPrompt).toContain('names who to call with their phone number');
    expect(deps.quo.createContactNote).toHaveBeenCalledWith('c1', expect.stringContaining('Air Guardian at (508) 355-0044'));
    expect(deps.qb.createEstimate).not.toHaveBeenCalled();
  });

  it('drafts without the rules when the store read fails', async () => {
    const { deps, redis, logs } = makeDeps();
    vi.spyOn(redis, 'hgetall').mockRejectedValue(new Error('redis down'));
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ Id: '9', DisplayName: 'Sean Test' });
    (deps.quo.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ direction: 'incoming', createdAt: '2026-10-21T15:00:00Z', text: 'hello', media: [] }],
    });
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ lines: [], scope_accounting: [{ request: 'x', quoted_item: null, reason: 'r', suggested_reply: 'no' }], confidence: 'low', needs_site_visit: false, reasoning: 'r', open_questions: [] }),
    );
    await draftOne(deps, draftOpts());
    expect(logs.some((l) => l.includes('can-help rules failed (redis down)'))).toBe(true);
    const opts = (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][1] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain("WE CAN'T HELP WITH");
  });
});

// ── trigger loop ───────────────────────────────────────────────────────

describe('runTick', () => {
  it('does nothing when mode is off', async () => {
    const { deps, redis } = makeDeps();
    await redis.lpush(keys.quoteTriggerQueue, JSON.stringify(ev()));
    const summary = await runTick(deps, 'off');
    expect(summary.skipped).toBe('off');
    expect(summary.drained).toBe(0);
  });

  it('honors the Redis mode override over the env default', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterMode, 'off');
    const summary = await runTick(deps, 'live');
    expect(summary.mode).toBe('off');
  });

  it('prunes T2 and T4 dedupe fields past DEDUPE_PRUNE_MS, keeps ones inside the window', async () => {
    const { deps, redis } = makeDeps();
    const now = deps.now();
    const old = new Date(now - DEDUPE_PRUNE_MS - 60_000).toISOString();
    const fresh = new Date(now - 3_600_000).toISOString();
    await redis.hset(keys.quoteTriggerT4Done, { '77': old, '78': fresh });
    await redis.hset(keys.quoteTriggerT2Done, { '+16175550001': old, '+16175550002': fresh });
    await runTick(deps, 'live');
    expect(await redis.hget(keys.quoteTriggerT4Done, '77')).toBeNull();
    expect(await redis.hget(keys.quoteTriggerT4Done, '78')).toBe(fresh);
    expect(await redis.hget(keys.quoteTriggerT2Done, '+16175550001')).toBeNull();
    expect(await redis.hget(keys.quoteTriggerT2Done, '+16175550002')).toBe(fresh);
    // the prune horizon is well past the 24h window the dedupe checks read
    expect(DEDUPE_PRUNE_MS).toBeGreaterThan(Math.max(T2_DEDUPE_H, T4_DEDUPE_H) * 3_600_000 * 5);
  });

  it('skips when another run holds the lock', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterRunLock, 'held');
    const summary = await runTick(deps, 'live');
    expect(summary.skipped).toBe('locked');
    // and does not release the other run's lock
    expect(await redis.get(keys.quoteDrafterRunLock)).toBe('held');
  });

  it('takes the lock with a unique token and a TTL longer than quote-tick maxDuration (800s)', async () => {
    const { deps, redis } = makeDeps();
    const setSpy = vi.spyOn(redis, 'set');
    await runTick(deps, 'live');
    await runTick(deps, 'live');
    const lockCalls = setSpy.mock.calls.filter(([k]) => k === keys.quoteDrafterRunLock);
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0][2]).toMatchObject({ nx: true, px: RUN_LOCK_TTL_MS });
    expect(RUN_LOCK_TTL_MS).toBeGreaterThanOrEqual(900_000);
    expect(lockCalls[0][1]).not.toBe(lockCalls[1][1]);
  });

  it("does not release a later run's lock when its own expired mid-run", async () => {
    const { deps, redis } = makeDeps();
    // Mid-run, our lock expires and the next tick takes it.
    const realZrange = redis.zrange.bind(redis);
    vi.spyOn(redis, 'zrange').mockImplementation(async <T,>(key: string, min: number, max: number, opts: { byScore: true }) => {
      redis.kv.set(keys.quoteDrafterRunLock, 'next-tick-token');
      return realZrange<T>(key, min, max, opts);
    });
    await runTick(deps, 'live');
    expect(await redis.get(keys.quoteDrafterRunLock)).toBe('next-tick-token');
  });

  it('releaseRunLock deletes only on a token match and never throws', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterRunLock, 'mine');
    expect(await releaseRunLock(deps, 'not-mine')).toBe(false);
    expect(await redis.get(keys.quoteDrafterRunLock)).toBe('mine');
    expect(await releaseRunLock(deps, 'mine')).toBe(true);
    expect(await redis.get(keys.quoteDrafterRunLock)).toBeNull();

    vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(releaseRunLock(deps, 'mine')).resolves.toBe(false);
  });

  it('buffers events per phone and leaves them settling until the window closes', async () => {
    const { deps, redis } = makeDeps();
    // event 5 minutes ago — settle window (15 min) still open
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ at: '2026-10-21T15:55:00Z', hasMedia: true })),
    );
    const summary = await runTick(deps, 'live');
    expect(summary.drained).toBe(1);
    expect(summary.due).toBe(0);
    expect(summary.settling).toBe(1);
    expect(summary.drafted).toBe(0);
    // lock released
    expect(await redis.get(keys.quoteDrafterRunLock)).toBeNull();
  });

  it('drafts a due T1 phone and consumes its buffer', async () => {
    const { deps, redis } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '9',
      DisplayName: 'Jane',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '1', SyncToken: '0', DocNumber: '1500', TxnStatus: 'Pending', TxnDate: '2026-10-19' },
    ]);
    await redis.hset(keys.quoteDrafterAssets, {
      ruleset: 'https://blob.test/ruleset.md',
      updatedAt: 't1',
    });
    await redis.set(keys.quoteDrafterT4Mode, 'live'); // exercise the live flag write
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECTION 0')));
    // event 20 minutes ago — due
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ at: '2026-10-21T15:40:00Z', hasMedia: true })),
    );
    try {
      const summary = await runTick(deps, 'live');
      expect(summary.due).toBe(1);
      expect(summary.drafted).toBe(1);
      // the 2-day-old human Pending estimate blocks stacking — since T4
      // (2026-10-29) trigger runs flag that instead of skipping silently
      expect(summary.records[0]?.record?.outcome).toBe('flagged');
      expect(summary.records[0]?.trigger).toBe('T1');
      expect(redis.lists.get(keys.quoteScopeFlags)?.length).toBe(1);
      // buffer + due entry consumed
      expect(await redis.hget(keys.quoteTriggerPending, '+15083611747')).toBeNull();
      expect(await redis.zcard(keys.quoteTriggerDue)).toBe(0);
      // runlog written
      expect(redis.lists.get(keys.quoteDrafterRunlog)?.length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      clearAssetCache();
    }
  });

  it('records a no-trigger verdict without drafting', async () => {
    const { deps, redis } = makeDeps();
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ at: '2026-10-21T15:40:00Z', snippet: 'ok thanks' })),
    );
    const summary = await runTick(deps, 'live');
    expect(summary.due).toBe(1);
    expect(summary.drafted).toBe(0);
    const log = redis.lists.get(keys.quoteDrafterRunlog) ?? [];
    expect(JSON.parse(log[0] as string).trigger).toBe('none');
  });

  it('skips internal numbers at drain time', async () => {
    const { deps, redis } = makeDeps();
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ phone: '+16176681677', at: '2026-10-21T15:40:00Z', hasMedia: true })),
    );
    const summary = await runTick(deps, 'live');
    expect(summary.drained).toBe(1);
    expect(summary.due).toBe(0);
    expect(await redis.zcard(keys.quoteTriggerDue)).toBe(0);
  });
});

// ── T2 visit matching ──────────────────────────────────────────────────

describe('resolveVisitCustomers', () => {
  it('matches events to customers by last-name token and dedupes', () => {
    const out = resolveVisitCustomers(
      [
        { summary: 'Skinner — crack assessment', startMs: 1 },
        { summary: 'Skinner follow-up', startMs: 2 },
        { summary: 'Mike OOO', startMs: 3 },
      ],
      [
        { name: 'John Skinner', phones: ['+15083611747'] },
        { name: 'No Phone', phones: [] },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'John Skinner', phone: '+15083611747' });
  });

  it('never matches internal numbers', () => {
    const out = resolveVisitCustomers(
      [{ summary: 'Carrington debrief', startMs: 1 }],
      [{ name: 'Mike Carrington', phones: ['+18573126761'] }],
    );
    expect(out).toHaveLength(0);
  });
});

// ── assets ─────────────────────────────────────────────────────────────

describe('loadAssets', () => {
  it('returns null without a manifest and caches by updatedAt', async () => {
    clearAssetCache();
    const redis = new MiniRedis();
    expect(await loadAssets(redis as unknown as Redis)).toBeNull();

    await redis.hset(keys.quoteDrafterAssets, {
      ruleset: 'https://blob.test/r.md',
      exemplars: 'https://blob.test/e.jsonl',
      updatedAt: 'v1',
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      new Response(String(url).includes('e.jsonl') ? '{"docNumber":"1"}\n{"docNumber":"2"}' : 'SECTION 0'),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const assets = await loadAssets(redis as unknown as Redis);
      expect(assets?.rulesetText).toBe('SECTION 0');
      expect(assets?.exemplarLibrary).toHaveLength(2);
      // second call served from cache — no new fetches
      await loadAssets(redis as unknown as Redis);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      clearAssetCache();
    }
  });
});

// ── T4: scope-change gate ───────────────────────────────────────────────

function openEntry(overrides: Partial<OpenQuoteEntry> = {}): OpenQuoteEntry {
  return {
    estimateId: '77',
    docNumber: '1576',
    customerId: '9',
    customer: 'Kshitij Bichave',
    email: 'kb@example.com',
    total: 1325,
    linesSummary: 'Crack Repair ×1 @ $1325',
    botOwned: false,
    updatedAt: '2026-10-21T12:00:00Z',
    ...overrides,
  };
}

describe('parseGateVerdict', () => {
  it('parses plain and fenced JSON', () => {
    expect(parseGateVerdict('{"scopeRelevant": true, "reason": "finished basement"}')).toEqual({
      scopeRelevant: true,
      reason: 'finished basement',
    });
    expect(
      parseGateVerdict('```json\n{"scopeRelevant": false, "reason": "scheduling"}\n```'),
    ).toEqual({ scopeRelevant: false, reason: 'scheduling' });
  });

  it('returns null on garbage or missing fields', () => {
    expect(parseGateVerdict('not json')).toBeNull();
    expect(parseGateVerdict('{"reason": "no verdict"}')).toBeNull();
  });
});

describe('buildScopeGatePrompt', () => {
  it('includes the quote, context, and new content', () => {
    const prompt = buildScopeGatePrompt({
      open: openEntry(),
      newContent: ['[text 2026-10-28T15:50:00Z] basement is finished'],
      context: [{ direction: 'incoming', at: 't', text: 'photos attached' }],
    });
    expect(prompt).toContain('Quote #1576 — $1325');
    expect(prompt).toContain('basement is finished');
    expect(prompt).toContain('[CUSTOMER] photos attached');
  });
});

describe('runTick T4', () => {
  async function seedInbound(redis: MiniRedis, overrides: Partial<TriggerEvent> = {}) {
    // due: 20 minutes before the mocked now
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ at: '2026-10-21T15:40:00Z', snippet: 'the basement is finished', ...overrides })),
    );
  }

  it('flags a human-owned open quote when the gate says scope-relevant', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterT4Mode, 'live');
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry({ botOwned: false }));
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"scopeRelevant": true, "reason": "finished basement — drywall removal"}',
    );
    await seedInbound(redis);
    const summary = await runTick(deps, 'live');
    expect(summary.due).toBe(1);
    expect(summary.drafted).toBe(0); // flag, not draft
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('T4');
    expect(log[0].record.outcome).toBe('flagged');
    const flags = (redis.lists.get(keys.quoteScopeFlags) ?? []).map((r) => JSON.parse(r as string));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ docNumber: '1576', channel: 'text' });
    // dedupe marker set
    expect(await redis.hget(keys.quoteTriggerT4Done, '77')).toBeTruthy();
  });

  it('defaults to T4 shadow under a live global mode — verdict logged, nothing written', async () => {
    const { deps, redis } = makeDeps();
    // no quoteDrafterT4Mode key set — default must be shadow
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"scopeRelevant": true, "reason": "finished basement"}',
    );
    await seedInbound(redis);
    await runTick(deps, 'live');
    expect(redis.lists.get(keys.quoteScopeFlags)).toBeUndefined();
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('T4');
    expect(log[0].mode).toBe('shadow');
    expect(log[0].record.outcome).toBe('flagged');
  });

  it('skips the gate entirely when T4 mode is off', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterT4Mode, 'off');
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    await seedInbound(redis);
    await runTick(deps, 'live'); // default gemini mock rejects — a gate call would fail loudly
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('none');
  });

  it('suppresses flag side effects in shadow but still logs the verdict', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"scopeRelevant": true, "reason": "finished basement"}',
    );
    await seedInbound(redis);
    const summary = await runTick(deps, 'shadow');
    expect(summary.drafted).toBe(0);
    expect(redis.lists.get(keys.quoteScopeFlags)).toBeUndefined();
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('T4');
    expect(log[0].record.outcome).toBe('flagged');
  });

  it('runs the draft path for a bot-owned open quote', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry({ botOwned: true }));
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"scopeRelevant": true, "reason": "finished basement"}',
    );
    await redis.hset(keys.quoteDrafterAssets, { ruleset: 'https://blob.test/r.md', updatedAt: 'v1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECTION 0')));
    await seedInbound(redis);
    try {
      const summary = await runTick(deps, 'live');
      expect(summary.drafted).toBe(1);
      expect(summary.records[0]?.trigger).toBe('T4');
      // with no resolvable customer/messages the draft itself skips, but the
      // T4 job ran through draftOne with hasNewInbound
      expect(summary.records[0]?.record?.outcome).toBe('skipped');
    } finally {
      vi.unstubAllGlobals();
      clearAssetCache();
    }
  });

  it('records a gate-no verdict without flagging and without dedupe', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    (deps.gemini.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"scopeRelevant": false, "reason": "just a scheduling question"}',
    );
    await seedInbound(redis, { snippet: 'can we do Tuesday instead?' });
    await runTick(deps, 'live');
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('T4');
    expect(log[0].record.outcome).toBe('skipped');
    expect(redis.lists.get(keys.quoteScopeFlags)).toBeUndefined();
    expect(await redis.hget(keys.quoteTriggerT4Done, '77')).toBeNull();
  });

  it('dedupes a second T4 within 24h of the first action', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    await redis.hset(keys.quoteTriggerT4Done, { '77': '2026-10-21T10:00:00Z' });
    await seedInbound(redis);
    await runTick(deps, 'live');
    // gemini never called (default mock rejects — reaching it would fail loudly)
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('none');
    expect(log[0].why).toContain('deduped');
  });

  it('stays silent for phones with no open quote', async () => {
    const { deps, redis } = makeDeps();
    await seedInbound(redis);
    await runTick(deps, 'live');
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log[0].trigger).toBe('none');
  });

  it('re-arms the buffer while a voicemail transcript is pending', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    (deps.quo.getCallVoicemail as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: 'c1',
      status: 'in-progress',
    });
    await seedInbound(redis, { kind: 'voicemail', callId: 'c1', snippet: '' });
    await runTick(deps, 'live');
    // buffer restored with a retry count and the due clock pushed out
    const pending = await redis.hget<TriggerEvent[]>(keys.quoteTriggerPending, '+15083611747');
    expect(pending?.[0]?.retries).toBe(1);
    expect(await redis.zcard(keys.quoteTriggerDue)).toBe(1);
  });

  it('uses the fetched voicemail transcript as gate content', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterT4Mode, 'live');
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    (deps.quo.getCallVoicemail as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: 'c1',
      status: 'completed',
      transcript: 'hey the basement is actually finished, drywall everywhere',
    });
    const gen = deps.gemini.generateContent as ReturnType<typeof vi.fn>;
    gen.mockResolvedValue('{"scopeRelevant": true, "reason": "finished basement"}');
    await seedInbound(redis, { kind: 'voicemail', callId: 'c1', snippet: '' });
    await runTick(deps, 'live');
    expect(gen.mock.calls[0][0]).toContain('drywall everywhere');
    const flags = (redis.lists.get(keys.quoteScopeFlags) ?? []).map((r) => JSON.parse(r as string));
    expect(flags[0]).toMatchObject({ channel: 'voicemail' });
  });
});

describe('runTick with the inbound router quote route live', () => {
  const routed = (over: Partial<Parameters<typeof enqueueRoutedQuote>[2]> = {}) => ({
    trigger: 'T1' as const,
    why: 'T1 2 photo(s)',
    channel: 'photos',
    at: '2026-10-21T15:58:00Z',
    ...over,
  });

  it('the router owns customer texts, photos and voicemails; the loop keeps the rest', () => {
    expect(routerOwnsEvent(ev({ hasMedia: true }))).toBe(true);
    expect(routerOwnsEvent(ev({ kind: 'voicemail', callId: 'c1' }))).toBe(true);
    expect(routerOwnsEvent(ev({ direction: 'outgoing', snippet: "I'll get you a quote" }))).toBe(false);
    expect(routerOwnsEvent(ev({ kind: 'email' }))).toBe(false);
    expect(routerOwnsEvent(ev({ kind: 'call-transcript', callId: 'c1' }))).toBe(false);
  });

  it('drops router-owned events at drain time and buffers the rest', async () => {
    const { deps, redis } = makeDeps();
    await redis.lpush(keys.quoteTriggerQueue, JSON.stringify(ev({ at: '2026-10-21T15:55:00Z', hasMedia: true })));
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ phone: '+15085550101', direction: 'outgoing', at: '2026-10-21T15:55:00Z', snippet: "I'll write up a quote" })),
    );
    const summary = await runTick(deps, 'live', { routerOwnsInbound: true });
    expect(summary.drained).toBe(2);
    expect(await redis.hget(keys.quoteTriggerPending, '+15083611747')).toBeNull();
    expect(await redis.hget(keys.quoteTriggerPending, '+15085550101')).not.toBeNull();
  });

  it('drafts a routed T1 on the next tick without the debounce, with buffered events riding along', async () => {
    const { deps, redis } = makeDeps();
    await redis.hset(keys.quoteDrafterAssets, { ruleset: 'https://blob.test/r.md', updatedAt: 'v1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECTION 0')));
    await redis.lpush(
      keys.quoteTriggerQueue,
      JSON.stringify(ev({ direction: 'outgoing', at: '2026-10-21T15:57:00Z', snippet: 'got them, thanks' })),
    );
    await enqueueRoutedQuote(redis as unknown as Redis, '+15083611747', routed());
    try {
      const summary = await runTick(deps, 'live', { routerOwnsInbound: true });
      expect(summary.due).toBe(1);
      expect(summary.drafted).toBe(1);
      expect(summary.records[0]).toMatchObject({ trigger: 'T1', why: 'T1 2 photo(s) (inbound router)', events: 2 });
      expect(await redis.hget(keys.quoteTriggerRouted, '+15083611747')).toBeNull();
      expect(await redis.hget(keys.quoteTriggerPending, '+15083611747')).toBeNull();
      expect(await redis.zcard(keys.quoteTriggerDue)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      clearAssetCache();
    }
  });

  it('a routed T4 on a human-owned quote flags it with no gate call', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterT4Mode, 'live');
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry({ botOwned: false }));
    await enqueueRoutedQuote(redis as unknown as Redis, '+15083611747', routed({ trigger: 'T4', why: 'T4 open quote: scope change', channel: 'text' }));
    await runTick(deps, 'live', { routerOwnsInbound: true }); // default gemini mock rejects — a gate call would fail
    const flags = (redis.lists.get(keys.quoteScopeFlags) ?? []).map((r) => JSON.parse(r as string));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ docNumber: '1576', channel: 'text', reason: 'T4 open quote: scope change (inbound router)' });
    expect(await redis.hget(keys.quoteTriggerT4Done, '77')).toBeTruthy();
  });

  it('a routed T4 respects the 24h dedupe and T4 off', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry());
    await redis.hset(keys.quoteTriggerT4Done, { '77': '2026-10-21T10:00:00Z' });
    await enqueueRoutedQuote(redis as unknown as Redis, '+15083611747', routed({ trigger: 'T4' }));
    await runTick(deps, 'live', { routerOwnsInbound: true });
    await redis.set(keys.quoteDrafterT4Mode, 'off');
    await enqueueRoutedQuote(redis as unknown as Redis, '+15083611747', routed({ trigger: 'T4' }));
    await runTick(deps, 'live', { routerOwnsInbound: true });
    const log = (redis.lists.get(keys.quoteDrafterRunlog) ?? []).map((r) => JSON.parse(r as string));
    expect(log.map((l) => l.why)).toEqual(['router T4, T4 off', 'T4 deduped — #1576 actioned 2026-10-21T10:00:00Z']);
    expect(redis.lists.get(keys.quoteScopeFlags)).toBeUndefined();
  });
});

describe('draftOne flagHumanOwned', () => {
  it('returns flagged instead of skipped for a human-owned bot draft', async () => {
    const { deps, redis } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '9',
      DisplayName: 'Jane',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        Id: '77',
        SyncToken: '3',
        DocNumber: '1576',
        TxnStatus: 'Pending',
        TotalAmt: 1325,
        PrivateNote: 'BOT DRAFT — review before sending',
        Line: [],
      },
    ]);
    await redis.set(keys.quoteDraftSyncToken('77'), '0'); // stored ≠ live → human-owned
    const record = await draftOne(deps, draftOpts({ flagHumanOwned: true }));
    expect(record.outcome).toBe('flagged');
    expect(record.docNumber).toBe('1576');
    // index refreshed to human-owned
    const entry = await getOpenQuote(redis as unknown as Redis, '+15083611747');
    expect(entry?.botOwned).toBe(false);
  });

  it('flags when a human Pending estimate blocks stacking', async () => {
    const { deps } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '9',
      DisplayName: 'Jane',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '80', SyncToken: '0', DocNumber: '1580', TxnStatus: 'Pending', TxnDate: '2026-10-19', TotalAmt: 900, Line: [] },
    ]);
    const record = await draftOne(
      deps,
      draftOpts({ flagHumanOwned: true, skipIfRecentEstimateDays: 30 }),
    );
    expect(record.outcome).toBe('flagged');
    expect(record.docNumber).toBe('1580');
  });

  it('keeps the silent skip for manual runs without the option', async () => {
    const { deps } = makeDeps();
    (deps.qb.findCustomerByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: '9',
      DisplayName: 'Jane',
    });
    (deps.qb.getEstimatesByCustomer as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '80', SyncToken: '0', DocNumber: '1580', TxnStatus: 'Pending', TxnDate: '2026-10-19', TotalAmt: 900, Line: [] },
    ]);
    const record = await draftOne(deps, draftOpts({ skipIfRecentEstimateDays: 30 }));
    expect(record.outcome).toBe('skipped');
  });
});

// ── open-quote index ────────────────────────────────────────────────────

describe('syncOpenQuoteIndex', () => {
  it('indexes Pending estimates with phone/email and refreshes ownership', async () => {
    const { deps, redis } = makeDeps();
    (deps.qb.listRecentEstimates as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        Id: '77',
        SyncToken: '1',
        DocNumber: '1576',
        TxnStatus: 'Pending',
        TxnDate: '2026-10-20',
        CustomerRef: { value: '9', name: 'Jane' },
        TotalAmt: 1325,
        BillEmail: { Address: 'jane@example.com' },
        Line: [
          { SalesItemLineDetail: { ItemRef: { value: 'i1', name: 'Crack Repair' }, Qty: 1, UnitPrice: 1325 } },
        ],
      },
      { Id: '78', SyncToken: '0', TxnStatus: 'Accepted', TxnDate: '2026-10-20', CustomerRef: { value: '9' }, Line: [] },
    ]);
    (deps.qb.listAllCustomers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '9', DisplayName: 'Jane Doe', PrimaryPhone: { FreeFormNumber: '508-361-1747' } },
    ]);
    await redis.set(keys.quoteDraftSyncToken('77'), '0'); // live token is 1 → human-owned
    // stale entry that should be removed (old updatedAt, not in desired set)
    await upsertOpenQuote(redis as unknown as Redis, '+19998887777', openEntry({ updatedAt: '2026-10-20T00:00:00Z' }));
    // fresh entry inside the grace window — must survive
    await upsertOpenQuote(
      redis as unknown as Redis,
      '+17778889999',
      openEntry({ updatedAt: '2026-10-21T15:50:00Z' }),
    );

    const result = await syncOpenQuoteIndex(deps);
    expect(result).toMatchObject({ indexed: 1, removed: 1 });
    const entry = await getOpenQuote(redis as unknown as Redis, '+15083611747');
    expect(entry).toMatchObject({
      estimateId: '77',
      docNumber: '1576',
      customer: 'Jane Doe',
      email: 'jane@example.com',
      botOwned: false,
      linesSummary: 'Crack Repair ×1 @ $1325',
    });
    expect(await getOpenQuote(redis as unknown as Redis, '+19998887777')).toBeNull();
    expect(await getOpenQuote(redis as unknown as Redis, '+17778889999')).not.toBeNull();
    // self-gates: immediate second call is a no-op
    expect(await syncOpenQuoteIndex(deps)).toBeNull();
  });
});

// ── email channel ───────────────────────────────────────────────────────

describe('pollQuoteEmails', () => {
  it('enqueues inbound mail from open-quote senders exactly once', async () => {
    const { deps, redis } = makeDeps();
    await upsertOpenQuote(redis as unknown as Redis, '+15083611747', openEntry({ email: 'KB@Example.com' }));
    const gmail = {
      listMessages: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          fromAddress: 'kb@example.com',
          subject: 'About the quote',
          body: 'turns out the basement is finished',
          snippet: '',
          at: '2026-10-21T15:00:00Z',
          attachments: [],
        },
        {
          id: 'm2',
          fromAddress: 'random@elsewhere.com',
          subject: 'spam',
          body: '',
          snippet: '',
          at: '2026-10-21T15:00:00Z',
          attachments: [],
        },
      ]),
    };
    const pollDeps = {
      redis: redis as unknown as Redis,
      gmail: gmail as never,
      log: () => {},
      now: deps.now,
    };
    const first = await pollQuoteEmails(pollDeps);
    expect(first).toMatchObject({ openQuotes: 1, enqueued: 1 });
    const queued = (redis.lists.get(keys.quoteTriggerQueue) ?? []).map((r) => JSON.parse(r as string));
    expect(queued[0]).toMatchObject({ phone: '+15083611747', kind: 'email', direction: 'incoming' });
    expect(queued[0].snippet).toContain('basement is finished');
    // second poll: m1 already seen
    const second = await pollQuoteEmails(pollDeps);
    expect(second.enqueued).toBe(0);
  });

  it('does nothing when no open quote has an email', async () => {
    const { deps, redis } = makeDeps();
    const gmail = { listMessages: vi.fn() };
    const summary = await pollQuoteEmails({
      redis: redis as unknown as Redis,
      gmail: gmail as never,
      log: () => {},
      now: deps.now,
    });
    expect(summary.openQuotes).toBe(0);
    expect(gmail.listMessages).not.toHaveBeenCalled();
  });
});

// ── open-quote entry roundtrip ──────────────────────────────────────────

describe('open-quote index helpers', () => {
  it('roundtrips entries through the hash', async () => {
    const redis = new MiniRedis() as unknown as Redis;
    await upsertOpenQuote(redis, '+15083611747', openEntry());
    expect((await getOpenQuote(redis, '+15083611747'))?.docNumber).toBe('1576');
    const all = await listOpenQuotes(redis);
    expect(all.size).toBe(1);
  });
});

// ── doc number re-check before create ─────────────────────────────────

describe('confirmNextDocNumber', () => {
  it('keeps the planned number when QBO has not used it', async () => {
    const { deps } = makeDeps();
    (deps.qb.listRecentEstimates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '1', DocNumber: '1599' },
      { Id: '2', DocNumber: 'abc' },
    ]);
    const run = { ...RUN, nextDocNumber: 1600 };
    expect(await confirmNextDocNumber(deps, run)).toBe(1600);
    expect(run.nextDocNumber).toBe(1600);
  });

  it('does not reuse a number taken since the run snapshot; continues past the max', async () => {
    const { deps, logs } = makeDeps();
    (deps.qb.listRecentEstimates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { Id: '1', DocNumber: '1600' }, // the concurrent run's draft
      { Id: '2', DocNumber: '1601' }, // and a human quote after it
    ]);
    const run = { ...RUN, nextDocNumber: 1600 };
    expect(await confirmNextDocNumber(deps, run)).toBe(1602);
    expect(run.nextDocNumber).toBe(1602);
    expect(logs.some((l) => l.includes('#1600 already taken'))).toBe(true);
  });

  it('throws (draft recorded as failed) when QBO cannot be read, rather than guess', async () => {
    const { deps } = makeDeps();
    (deps.qb.listRecentEstimates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('QBO 503'));
    await expect(confirmNextDocNumber(deps, { ...RUN })).rejects.toThrow('QBO 503');
  });
});
