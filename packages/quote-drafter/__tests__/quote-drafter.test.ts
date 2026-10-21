import { describe, it, expect, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { classify, type TriggerEvent, type DrafterDeps } from '../src/types.js';
import { draftOne, type DraftOneOptions, type RunContext } from '../src/drafter.js';
import { runTick, resolveVisitCustomers } from '../src/trigger.js';
import { loadAssets, clearAssetCache } from '../src/assets.js';

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
    opts: { gt?: boolean },
    member: { score: number; member: string },
  ): Promise<number> {
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

  it('skips when another run holds the lock', async () => {
    const { deps, redis } = makeDeps();
    await redis.set(keys.quoteDrafterRunLock, 'held');
    const summary = await runTick(deps, 'live');
    expect(summary.skipped).toBe('locked');
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
      // skip-if-recent fired inside draftOne (estimate 2 days old)
      expect(summary.records[0]?.record?.outcome).toBe('skipped');
      expect(summary.records[0]?.trigger).toBe('T1');
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
