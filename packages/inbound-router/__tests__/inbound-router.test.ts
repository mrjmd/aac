import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
vi.mock('@aac/message-drafts', async (orig) => ({
  ...(await orig<typeof import('@aac/message-drafts')>()),
  processRoutedIntake: vi.fn(),
  processRoutedReferral: vi.fn(),
}));
import { processRoutedIntake, processRoutedReferral, type DraftDeps } from '@aac/message-drafts';
import {
  act,
  burstContent,
  decide,
  liveRoutes,
  routedIntake,
  routedReferral,
  sweepInbound,
  parseRead,
  routePhone,
  rulesForRead,
  runInboundTick,
  threadFingerprint,
  threadState,
  type InboundRead,
  type RouterDeps,
  type ShadowEntry,
  type Thread,
  type ThreadState,
} from '../src/index.js';
import type { Referral, StandingRule } from '@aac/quoting';

// ── fakes ───────────────────────────────────────────────────────────────

class MiniRedis {
  strings = new Map<string, unknown>();
  hashes = new Map<string, Map<string, unknown>>();
  zsets = new Map<string, Map<string, number>>();
  lists = new Map<string, unknown[]>();
  async get<T>(key: string): Promise<T | null> {
    const v = this.strings.get(key);
    if (v === undefined) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as T;
      } catch {
        return v as T;
      }
    }
    return v as T;
  }
  async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<'OK' | null> {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    const v = this.hashes.get(key)?.get(field);
    return v === undefined ? null : (v as T);
  }
  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const h = this.hashes.get(key) ?? new Map();
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
    this.hashes.set(key, h);
    return 1;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let n = 0;
    for (const f of fields) if (this.hashes.get(key)?.delete(f)) n++;
    return n;
  }
  async hsetnx(key: string, field: string, value: unknown): Promise<number> {
    if (this.hashes.get(key)?.has(field)) return 0;
    await this.hset(key, { [field]: value });
    return 1;
  }
  async zadd(
    key: string,
    a: { score: number; member: string } | { nx?: boolean },
    b?: { score: number; member: string },
  ): Promise<number> {
    const m = (b ?? a) as { score: number; member: string };
    const z = this.zsets.get(key) ?? new Map();
    if (b && (a as { nx?: boolean }).nx && z.has(m.member)) return 0;
    z.set(m.member, m.score);
    this.zsets.set(key, z);
    return 1;
  }
  async zrange<T>(key: string, min: number, max: number): Promise<T> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m) as T;
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    return members.filter((m) => this.zsets.get(key)?.delete(m)).length;
  }
  async zscore(key: string, member: string): Promise<number | null> {
    return this.zsets.get(key)?.get(member) ?? null;
  }
  async lpush(key: string, ...values: unknown[]): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(...values);
    this.lists.set(key, l);
    return l.length;
  }
  async ltrim(key: string, start: number, stop: number): Promise<string> {
    this.lists.set(key, (this.lists.get(key) ?? []).slice(start, stop + 1));
    return 'OK';
  }
}

const NOW = Date.parse('2026-11-05T15:00:00Z');
const PHONE = '+15085551234';

const RULES: StandingRule[] = [
  { id: 'block-bulkhead', kind: 'decline', text: 'Leaking cinder block bulkhead walls.', referralIds: ['air-guardian'], since: '2026-01-01' },
  { id: 'old-rule', kind: 'decline', text: 'Paused rule.', since: '2026-01-01', paused: true },
];
const REFERRALS: Referral[] = [{ id: 'air-guardian', name: 'Air Guardian', phone: '(508) 355-0044', sends: 'block waterproofing' }];

function msg(id: string, direction: 'incoming' | 'outgoing', minsAgo: number, text: string, media = 0) {
  return {
    id,
    direction,
    text,
    createdAt: new Date(NOW - minsAgo * 60_000).toISOString(),
    media: Array.from({ length: media }, (_, i) => ({ url: `https://share.quo.com/${id}/${i}`, type: 'image/jpeg' })),
  };
}

function makeDeps(opts: {
  messages: ReturnType<typeof msg>[];
  calls?: Array<{ id: string; direction: string; duration: number; createdAt: string }>;
  voicemails?: Record<string, string>;
  answer?: unknown;
  geminiThrows?: boolean;
}) {
  const redis = new MiniRedis();
  redis.strings.set(keys.inboundRouterMode, 'shadow');
  const prompts: Array<{ prompt: string; images: number }> = [];
  const downloads: string[] = [];
  const deps: RouterDeps = {
    redis: redis as unknown as Redis,
    quo: {
      listMessages: async () => ({ data: opts.messages }),
      listCalls: async () => ({ data: opts.calls ?? [] }),
      getCallVoicemail: async (id: string) =>
        opts.voicemails?.[id] ? { status: 'completed', transcript: opts.voicemails[id] } : null,
      downloadMessageMedia: async (url: string) => {
        downloads.push(url);
        return { contentType: 'image/jpeg', data: new Uint8Array([1, 2, 3]).buffer };
      },
    } as unknown as RouterDeps['quo'],
    gemini: {
      generateContent: async (prompt: string, o?: { imageParts?: unknown[] }) => {
        if (opts.geminiThrows) throw new Error('Gemini (503)');
        prompts.push({ prompt, images: o?.imageParts?.length ?? 0 });
        return JSON.stringify(opts.answer);
      },
    } as unknown as RouterDeps['gemini'],
    canHelp: { rules: async () => RULES, referrals: async () => REFERRALS },
    now: () => NOW,
  };
  return { deps, redis, prompts, downloads };
}

function read(over: Partial<InboundRead> = {}, canHelp: Partial<InboundRead['canHelp']> = {}): InboundRead {
  return {
    phone: PHONE,
    at: new Date(NOW).toISOString(),
    fingerprint: 'f',
    classification: 'lead',
    propertyState: 'MA',
    entities: { name: null, address: null, email: null },
    intents: ['new_lead'],
    canHelp: { verdict: 'can-help', ruleIds: [], referralIds: [], reason: '', question: null, ...canHelp },
    photos: {},
    summary: '',
    ...over,
  };
}

function st(over: Partial<ThreadState> = {}): ThreadState {
  return { mattEngaged: false, mattRepliedLast: false, intakeDone: false, openQuote: false, quotePromised: false, newPhotos: 0, ...over };
}

const names = (routes: Array<{ route: string }>) => routes.map((r) => r.route);

// ── decide ──────────────────────────────────────────────────────────────

describe('decide', () => {
  it('not a lead → nothing', () => {
    expect(names(decide(read({ classification: 'solicitation' }), st()))).toEqual(['none']);
  });

  it("can't help → decline only, even with photos and a quote promise", () => {
    const r = decide(read({}, { verdict: 'cant-help', reason: 'block bulkhead leaking' }), st({ newPhotos: 3, quotePromised: true }));
    expect(r).toEqual([{ route: 'decline', why: 'block bulkhead leaking' }]);
  });

  it("can't help later in the conversation still declines", () => {
    expect(names(decide(read({}, { verdict: 'cant-help' }), st({ mattEngaged: true, intakeDone: true })))).toEqual(['decline']);
  });

  it("can't help but Matt has already answered → nothing", () => {
    expect(decide(read({}, { verdict: 'cant-help' }), st({ mattEngaged: true, mattRepliedLast: true }))).toEqual([
      { route: 'none', why: "can't help, Matt has already answered" },
    ]);
  });

  it('thanks or a sign-off → nothing, even on a declined or scheduling thread', () => {
    expect(decide(read({ intents: ['other'] }, { verdict: 'cant-help' }), st({ mattEngaged: true }))).toEqual([
      { route: 'none', why: 'nothing to act on (thanks / sign-off)' },
    ]);
    expect(names(decide(read({ intents: ['other'] }), st()))).toEqual(['none']);
  });

  it('a past customer canceling is not a first touch → scheduling, no intake', () => {
    expect(names(decide(read({ intents: ['scheduling_reply'] }), st()))).toEqual(['scheduling']);
  });

  it('CT goes to Luc even when the out-of-area rule fires', () => {
    expect(names(decide(read({ propertyState: 'CT' }, { verdict: 'cant-help', ruleIds: ['out-of-area'] }), st()))).toEqual(['ct-routing']);
  });

  it('need info on first touch → intake asks the one question, no quote', () => {
    const r = decide(read({}, { verdict: 'need-info', question: 'Is it poured concrete or block?' }), st({ newPhotos: 2 }));
    expect(r).toEqual([{ route: 'intake', why: 'one question first: Is it poured concrete or block?' }]);
  });

  it('need info once Matt is talking to them → nothing', () => {
    expect(names(decide(read({}, { verdict: 'need-info' }), st({ mattEngaged: true })))).toEqual(['none']);
  });

  it('CT first touch → CT routing only', () => {
    expect(names(decide(read({ propertyState: 'CT' }), st({ newPhotos: 2 })))).toEqual(['ct-routing']);
  });

  it('new lead with photos → intake and quote drafter', () => {
    expect(decide(read({ intents: ['new_lead', 'photos_sent'] }), st({ newPhotos: 3 }))).toEqual([
      { route: 'intake', why: 'new lead, no reply yet' },
      { route: 'quote', why: 'T1 3 photo(s)' },
    ]);
  });

  it('new lead without photos → intake only', () => {
    expect(names(decide(read(), st()))).toEqual(['intake']);
  });

  it('intake already done + Matt promised a quote → quote (T3) only', () => {
    expect(decide(read({ intents: ['quote_request'] }), st({ intakeDone: true, mattEngaged: true, quotePromised: true }))).toEqual([
      { route: 'quote', why: 'T3 quote promised' },
    ]);
  });

  it('open quote + scope change → the T4 gate, not a new quote', () => {
    const r = decide(read({ intents: ['scope_change'] }), st({ mattEngaged: true, openQuote: true, newPhotos: 1 }));
    expect(r).toEqual([{ route: 'quote-gate', why: 'T4 open quote: T1 1 photo(s), scope change' }]);
  });

  it('scheduling reply → scheduling', () => {
    expect(names(decide(read({ intents: ['scheduling_reply'] }), st({ mattEngaged: true })))).toEqual(['scheduling']);
  });

  it('existing customer with a question and nothing new → nothing', () => {
    expect(names(decide(read({ intents: ['question'] }), st({ mattEngaged: true })))).toEqual(['none']);
  });
});

// ── read parsing ────────────────────────────────────────────────────────

describe('parseRead', () => {
  const ctx = { ruleIds: new Set(['block-bulkhead']), referralIds: new Set(['air-guardian']), newPhotoKeys: ['m1:0'] };

  it('drops ids, intents and photo keys the model made up', () => {
    const r = parseRead(
      JSON.stringify({
        classification: 'lead',
        propertyState: 'MA',
        entities: { name: 'Sean K', address: null, email: '' },
        intents: ['new_lead', 'photos_sent', 'invented'],
        canHelp: { verdict: 'cant-help', ruleIds: ['block-bulkhead', 'nope'], referralIds: ['air-guardian', 'ghost'], reason: 'block', question: 'x' },
        photos: { 'm1:0': 'cinder block bulkhead wall, wet', 'm9:9': 'made up' },
        summary: 'Leaking block bulkhead.',
      }),
      ctx,
    );
    expect(r).toMatchObject({
      classification: 'lead',
      entities: { name: 'Sean K', address: null, email: null },
      intents: ['new_lead', 'photos_sent'],
      canHelp: { verdict: 'cant-help', ruleIds: ['block-bulkhead'], referralIds: ['air-guardian'], question: null },
      photos: { 'm1:0': 'cinder block bulkhead wall, wet' },
    });
  });

  it('unknown verdict reads as can-help, garbage reads as null', () => {
    expect(parseRead('{"classification":"lead","canHelp":{"verdict":"maybe"}}', ctx)?.canHelp.verdict).toBe('can-help');
    expect(parseRead('not json', ctx)).toBeNull();
  });
});

describe('rulesForRead', () => {
  it('shows active rules and referrals with their ids, skips paused rules', () => {
    const block = rulesForRead(RULES, REFERRALS, '2026-11-05');
    expect(block).toContain('[block-bulkhead] Leaking cinder block bulkhead walls. → refer: [air-guardian] Air Guardian (508) 355-0044');
    expect(block).not.toContain('Paused rule');
  });
});

// ── thread state ────────────────────────────────────────────────────────

describe('threadState', () => {
  const thread = (messages: ReturnType<typeof msg>[]): Thread =>
    ({ messages, calls: [], voicemails: new Map() }) as unknown as Thread;

  it('counts only this burst for photos and quote promises; auto-replies are not Matt', () => {
    const s = threadState(
      thread([
        msg('a', 'incoming', 300, 'old photos', 4),
        msg('b', 'outgoing', 290, "I'll get you a quote tomorrow"),
        msg('c', 'outgoing', 5, 'Apologies for missing your call, please send us a text with your name'),
        msg('d', 'incoming', 3, 'here you go', 2),
      ]),
      NOW - 10 * 60_000,
      { intakeDone: true, openQuote: false },
    );
    expect(s).toEqual({ mattEngaged: true, mattRepliedLast: false, intakeDone: true, openQuote: false, quotePromised: false, newPhotos: 2 });
  });

  it("Matt's reply after the customer's last text counts as answered; an auto-reply doesn't", () => {
    const at = NOW - 10 * 60_000;
    const x = { intakeDone: false, openQuote: false };
    expect(threadState(thread([msg('a', 'incoming', 5, 'hi'), msg('b', 'outgoing', 1, 'Sorry, we only do poured concrete')]), at, x).mattRepliedLast).toBe(true);
    expect(threadState(thread([msg('a', 'incoming', 5, 'hi'), msg('b', 'outgoing', 1, 'Apologies for missing your call')]), at, x).mattRepliedLast).toBe(false);
  });

  it('a promise inside the burst is T3; "just sent" is not', () => {
    const at = NOW - 10 * 60_000;
    expect(threadState(thread([msg('b', 'outgoing', 2, "I'll write up a quote tonight")]), at, { intakeDone: false, openQuote: false }).quotePromised).toBe(true);
    expect(threadState(thread([msg('b', 'outgoing', 2, 'Just sent the quote to your email')]), at, { intakeDone: false, openQuote: false }).quotePromised).toBe(false);
  });
});

// ── tick (shadow) ───────────────────────────────────────────────────────

const ANSWER = {
  classification: 'lead',
  propertyState: 'MA',
  entities: { name: 'Pat Doe', address: '12 Elm St, Quincy MA', email: null },
  intents: ['new_lead', 'photos_sent'],
  canHelp: { verdict: 'cant-help', ruleIds: ['block-bulkhead'], referralIds: ['air-guardian'], reason: 'water through block bulkhead walls', question: null },
  photos: { 'm2:0': 'block bulkhead wall, wet', 'm2:1': 'stairwell floor puddle' },
  summary: 'Leaking block bulkhead, first contact.',
};

describe('runInboundTick', () => {
  const messages = [msg('m1', 'incoming', 4, 'Water coming in my bulkhead'), msg('m2', 'incoming', 3, '', 2)];

  it('reads a settled burst once, logs the decision, posts nothing', async () => {
    const { deps, redis, prompts } = makeDeps({ messages, answer: ANSWER });
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    await redis.hset(keys.inboundFirst, { [PHONE]: NOW - 4 * 60_000 });
    await redis.zadd(keys.inboundDue, { score: NOW + 60_000, member: '+15085559999' }); // still settling

    const summary = await runInboundTick(deps);

    expect(summary.due).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].images).toBe(2);
    expect(prompts[0].prompt).toContain('[block-bulkhead]');
    const entry = summary.entries[0];
    expect(entry).toMatchObject({
      phone: PHONE,
      outcome: 'decided',
      routes: [{ route: 'decline', why: 'water through block bulkhead walls' }],
      read: { verdict: 'cant-help', referrals: ['Air Guardian (508) 355-0044'], photosRead: 2 },
      state: { newPhotos: 2, mattEngaged: false },
      legacy: { intake: null, quoteSettling: false },
    });
    // shadow log written, burst cleared, lock released, read saved
    expect(JSON.parse(redis.lists.get(keys.inboundShadowLog)![0] as string).phone).toBe(PHONE);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBeNull();
    expect(await redis.hget(keys.inboundFirst, PHONE)).toBeNull();
    expect(redis.strings.has(keys.inboundLock(PHONE))).toBe(false);
    expect((await redis.get<InboundRead>(keys.inboundRead(PHONE)))?.photos['m2:1']).toBe('stairwell floor puddle');
    // still-settling phone untouched
    expect(await redis.zscore(keys.inboundDue, '+15085559999')).toBe(NOW + 60_000);
  });

  it('an unchanged thread is not re-read; a new text reuses the old photo descriptions', async () => {
    const first = makeDeps({ messages, answer: ANSWER });
    await routePhone(first.deps, PHONE, NOW - 600_000);

    const again = await routePhone(first.deps, PHONE, NOW - 600_000);
    expect(again.outcome).toBe('unchanged');
    expect(first.prompts).toHaveLength(1);

    const later = makeDeps({ messages: [...messages, msg('m3', 'incoming', 1, 'Any update?')], answer: { ...ANSWER, photos: {} } });
    later.redis.strings = first.redis.strings;
    const entry = await routePhone(later.deps, PHONE, NOW - 600_000);
    expect(entry.outcome).toBe('decided');
    expect(later.downloads).toEqual([]);
    expect(later.prompts[0].images).toBe(0);
    expect(later.prompts[0].prompt).toContain('- m2:0: block bulkhead wall, wet');
    expect((await later.redis.get<InboundRead>(keys.inboundRead(PHONE)))?.photos['m2:0']).toBe('block bulkhead wall, wet');
  });

  it('records what the old paths had done', async () => {
    const { deps, redis } = makeDeps({ messages, answer: ANSWER });
    await redis.hset(keys.messageDraftIntakeDone, { [PHONE]: '2026-11-05T14:58:00.000Z' });
    await redis.zadd(keys.quoteTriggerDue, { score: NOW + 600_000, member: PHONE });
    const entry = await routePhone(deps, PHONE, NOW - 600_000);
    expect(entry.legacy).toEqual({ intake: '2026-11-05T14:58:00.000Z', quoteSettling: true });
    expect(entry.state?.intakeDone).toBe(true);
  });

  it('a Gemini failure is logged as failed, never thrown', async () => {
    const { deps, redis } = makeDeps({ messages, geminiThrows: true });
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    const summary = await runInboundTick(deps);
    expect(summary.entries[0]).toMatchObject({ outcome: 'failed', detail: 'gemini: Gemini (503)' });
    expect(redis.strings.has(keys.inboundLock(PHONE))).toBe(false);
  });

  it('skips internal numbers and a phone another tick holds', async () => {
    const { deps, redis, prompts } = makeDeps({ messages, answer: ANSWER });
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: '+16176681677' });
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    await redis.set(keys.inboundLock(PHONE), 'other');
    const summary = await runInboundTick(deps);
    expect(summary.entries.map((e: ShadowEntry) => e.outcome)).toEqual(['skipped']);
    expect(prompts).toHaveLength(0);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBe(NOW - 1000);
  });

  it('off (the default) reads nothing and clears settled bursts', async () => {
    const { deps, redis, prompts } = makeDeps({ messages, answer: ANSWER });
    redis.strings.delete(keys.inboundRouterMode);
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    await redis.hset(keys.inboundFirst, { [PHONE]: NOW - 4 * 60_000 });
    await redis.zadd(keys.inboundDue, { score: NOW + 60_000, member: '+15085559999' }); // still settling
    await redis.hset(keys.inboundFirst, { '+15085559999': NOW - 60_000 });

    expect(await runInboundTick(deps)).toEqual({ mode: 'off', due: 1, entries: [] });
    expect(prompts).toHaveLength(0);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBeNull();
    expect(await redis.hget(keys.inboundFirst, PHONE)).toBeNull();
    expect(await redis.zscore(keys.inboundDue, '+15085559999')).not.toBeNull();
    expect(redis.lists.get(keys.inboundShadowLog)).toBeUndefined();
  });
});

describe('missed calls', () => {
  const call = (id: string, minsAgo: number) => ({ id, direction: 'incoming', duration: 0, createdAt: new Date(NOW - minsAgo * 60_000).toISOString() });
  const t = (calls: ReturnType<typeof call>[], vms: Record<string, string> = {}, messages: ReturnType<typeof msg>[] = []) =>
    ({ messages, calls, voicemails: new Map(Object.entries(vms)) }) as unknown as Thread;
  const from = NOW - 10 * 60_000;

  it('a rang-out call waits for its voicemail inside the grace window, then gives up', () => {
    expect(burstContent(t([call('c1', 3)]), from, NOW)).toBe('waiting');
    expect(burstContent(t([call('c1', 16)]), NOW - 20 * 60_000, NOW)).toBe('none');
  });

  it('a voicemail or a text is something to read', () => {
    expect(burstContent(t([call('c1', 3)], { c1: 'Hi, I have a crack in my basement' }), from, NOW)).toBe('content');
    expect(burstContent(t([call('c1', 3)], {}, [msg('m1', 'incoming', 2, 'crack in my wall')]), from, NOW)).toBe('content');
  });

  it('the tick re-arms a waiting call without reading or logging it, and keeps the burst start', async () => {
    const { deps, redis, prompts } = makeDeps({ messages: [], calls: [call('c1', 3)] });
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    await redis.hset(keys.inboundFirst, { [PHONE]: NOW - 3 * 60_000 });
    const summary = await runInboundTick(deps);
    expect(summary.entries).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBe(NOW + 2 * 60_000);
    expect(await redis.hget(keys.inboundFirst, PHONE)).toBe(NOW - 3 * 60_000);
    expect(redis.lists.get(keys.inboundShadowLog)).toBeUndefined();
  });

  it('once the voicemail is transcribed the burst is read', async () => {
    const { deps, prompts } = makeDeps({ messages: [], calls: [call('c1', 5)], voicemails: { c1: 'My bulkhead leaks' }, answer: ANSWER });
    const entry = await routePhone(deps, PHONE, NOW - 6 * 60_000);
    expect(entry.outcome).toBe('decided');
    expect(prompts[0].prompt).toContain('voicemail: My bulkhead leaks');
  });

  it('a call that rang out long ago is skipped, not read', async () => {
    const { deps, prompts } = makeDeps({ messages: [], calls: [call('c1', 20)] });
    expect((await routePhone(deps, PHONE, NOW - 25 * 60_000)).outcome).toBe('skipped');
    expect(prompts).toHaveLength(0);
  });
});

describe('threadFingerprint', () => {
  it('changes when a new message lands', () => {
    const t = (ms: ReturnType<typeof msg>[]) => ({ messages: ms, calls: [], voicemails: new Map() }) as unknown as Thread;
    const a = threadFingerprint(t([msg('m1', 'incoming', 4, 'x')]));
    expect(threadFingerprint(t([msg('m1', 'incoming', 4, 'x')]))).toBe(a);
    expect(threadFingerprint(t([msg('m1', 'incoming', 4, 'x'), msg('m2', 'incoming', 1, 'y')]))).not.toBe(a);
  });
});

// ── phase 4: live routes ────────────────────────────────────────────────

describe('live routes', () => {
  const routed = vi.mocked(processRoutedIntake);
  beforeEach(() => {
    routed.mockReset();
    routed.mockResolvedValue({ kind: 'drafted', record: {} });
  });
  const drafts = {} as DraftDeps;
  const thread = {
    messages: [msg('m1', 'incoming', 6, 'Water in my bulkhead'), msg('m2', 'incoming', 5, '', 2)],
    calls: [{ id: 'c1', direction: 'incoming', duration: 0, createdAt: new Date(NOW - 8 * 60_000).toISOString() }],
    voicemails: new Map([['c1', 'Hi, bulkhead leaks, call me']]),
  } as unknown as Thread;
  const ctx = (routes: Array<{ route: string; why: string }>, state = st()) => ({
    read: read({ photos: { 'm2:0': 'block wall, wet', 'm2:1': 'puddle' } }, { verdict: 'cant-help', reason: 'leaking block', referralIds: ['air-guardian'] }),
    thread,
    state,
    routes: routes as never,
    referrals: new Map(REFERRALS.map((r) => [r.id, r])),
    burstFromMs: NOW - 8 * 60_000,
  });

  it('liveRoutes parses the comma list and ignores unknown names', async () => {
    const { deps, redis } = makeDeps({ messages: [] });
    expect([...(await liveRoutes(deps))]).toEqual([]);
    await redis.set(keys.inboundRouterLive, 'intake, bogus,quote');
    expect([...(await liveRoutes(deps))]).toEqual(['intake', 'quote']);
  });

  it('routedIntake carries the texts, voicemail, photo descriptions oldest first, referral numbers, and the burst start', () => {
    const r = routedIntake('decline', ctx([]).read, thread, ctx([]).referrals, NOW - 8 * 60_000);
    expect(r).toMatchObject({
      route: 'decline',
      verdict: 'cant-help',
      referrals: ['Air Guardian ((508) 355-0044)'],
      customerText: 'Water in my bulkhead\n[voicemail transcript] Hi, bulkhead leaks, call me',
      mediaCount: 2,
      photoNotes: ['block wall, wet', 'puddle'],
      inquiryAt: NOW - 8 * 60_000,
    });
    expect(r.flag).toBeUndefined();
    const nh = { ...ctx([]).read, propertyState: 'other' as const, entities: { name: null, address: 'Keene, NH', email: null } };
    expect(routedIntake('intake', nh, thread, ctx([]).referrals, NOW).flag).toBe('property outside Massachusetts (Keene, NH), your call on the drive');
  });

  it('intake live: intake, CT routing and a first-reply decline go to intake; nothing else does', async () => {
    const { deps } = makeDeps({ messages: [] });
    deps.drafts = drafts;
    const live = new Set(['intake'] as const);
    expect(await act(deps, PHONE, live, ctx([{ route: 'intake', why: '' }, { route: 'quote', why: '' }]))).toEqual([
      { route: 'intake', outcome: 'drafted' },
    ]);
    await act(deps, PHONE, live, ctx([{ route: 'ct-routing', why: '' }]));
    await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }]));
    expect(routed.mock.calls.map((c) => c[2].route)).toEqual(['intake', 'ct-routing', 'decline']);

    routed.mockClear();
    // a decline after Matt has engaged is not intake's; quote/scheduling aren't live
    expect(await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }], st({ mattEngaged: true })))).toEqual([]);
    expect(await act(deps, PHONE, live, ctx([{ route: 'quote', why: '' }, { route: 'scheduling', why: '' }]))).toEqual([]);
    expect(await act(deps, PHONE, new Set(), ctx([{ route: 'intake', why: '' }]))).toEqual([]);
    expect(routed).not.toHaveBeenCalled();
  });

  it('quote live: hands quote and quote-gate routes to the quote loop as T1, T3 or T4; nothing else', async () => {
    const { deps, redis } = makeDeps({ messages: [] });
    const live = new Set(['quote'] as const);
    const job = async () => {
      const raw = await redis.hget<string>(keys.quoteTriggerRouted, PHONE);
      return raw === null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
    };
    expect(await act(deps, PHONE, live, ctx([{ route: 'intake', why: '' }, { route: 'quote', why: 'T1 2 photo(s)' }], st({ newPhotos: 2 })))).toEqual([
      { route: 'quote', outcome: 'queued' },
    ]);
    expect(await job()).toMatchObject({ trigger: 'T1', why: 'T1 2 photo(s)', channel: 'photos + text + voicemail' });
    expect(await redis.zscore(keys.quoteTriggerDue, PHONE)).toBe(NOW);

    await act(deps, PHONE, live, ctx([{ route: 'quote', why: 'T3 quote promised' }], st({ quotePromised: true })));
    expect((await job()).trigger).toBe('T3');
    await act(deps, PHONE, live, ctx([{ route: 'quote-gate', why: 'T4 open quote: scope change' }], st({ openQuote: true })));
    expect((await job()).trigger).toBe('T4');

    redis.hashes.delete(keys.quoteTriggerRouted);
    expect(await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }]))).toEqual([]);
    expect(await act(deps, PHONE, live, ctx([{ route: 'scheduling', why: '' }]))).toEqual([]);
    expect(await job()).toBeNull();
    expect(routed).not.toHaveBeenCalled();
  });

  it('referral live: a decline once Matt is talking to them goes to the referral drafter; a first-reply decline does not', async () => {
    const referral = vi.mocked(processRoutedReferral);
    referral.mockReset();
    referral.mockResolvedValue({ kind: 'drafted', record: {} });
    const { deps } = makeDeps({ messages: [] });
    deps.drafts = drafts;
    const live = new Set(['referral'] as const);
    expect(await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }], st({ mattEngaged: true })))).toEqual([
      { route: 'decline', outcome: 'drafted' },
    ]);
    expect(referral.mock.calls[0][2]).toMatchObject({ reason: 'leaking block', referrals: ['Air Guardian ((508) 355-0044)'] });
    expect(await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }], st({ intakeDone: true })))).toHaveLength(1);
    referral.mockClear();
    // first reply: intake's, even when intake isn't live; other routes: not referral's
    expect(await act(deps, PHONE, live, ctx([{ route: 'decline', why: '' }]))).toEqual([]);
    expect(await act(deps, PHONE, live, ctx([{ route: 'quote', why: '' }], st({ mattEngaged: true })))).toEqual([]);
    expect(referral).not.toHaveBeenCalled();
    // both live on a first reply: intake drafts it, once
    await act(deps, PHONE, new Set(['intake', 'referral'] as const), ctx([{ route: 'decline', why: '' }]));
    expect(routed).toHaveBeenCalledTimes(1);
    expect(referral).not.toHaveBeenCalled();
  });

  it('routedReferral: both sides of the thread oldest first, auto-replies out, this burst\'s photos and voicemail', () => {
    const t = {
      messages: [
        msg('m0', 'incoming', 60 * 24, 'Crack in my foundation'),
        msg('a1', 'outgoing', 60 * 24 - 1, 'Apologies for missing your call! Please send us a text with your name'),
        msg('o1', 'outgoing', 60 * 23, 'Thanks Sean, quote is on the way'),
        ...thread.messages,
      ],
      calls: thread.calls,
      voicemails: thread.voicemails,
    } as unknown as Thread;
    const r = routedReferral(ctx([]).read, t, ctx([]).referrals, NOW - 8 * 60_000);
    expect(r.conversation).toEqual([
      'CUSTOMER: Crack in my foundation',
      'MATT: Thanks Sean, quote is on the way',
      'CUSTOMER: Water in my bulkhead',
      'CUSTOMER: [2 photo(s)]',
      'CUSTOMER: [voicemail] Hi, bulkhead leaks, call me',
    ]);
    expect(r.photoNotes).toEqual(['block wall, wet', 'puddle']);
    expect(r.referrals).toEqual(['Air Guardian ((508) 355-0044)']);
  });

  it('tick with intake live: drafts, logs what it did; a retry re-arms without another read', async () => {
    const messages = [msg('m1', 'incoming', 4, 'Water coming in my bulkhead'), msg('m2', 'incoming', 3, '', 2)];
    const { deps, redis, prompts } = makeDeps({ messages, answer: ANSWER });
    deps.drafts = drafts;
    redis.strings.delete(keys.inboundRouterMode);
    await redis.set(keys.inboundRouterLive, 'intake');
    await redis.zadd(keys.inboundDue, { score: NOW - 1000, member: PHONE });
    await redis.hset(keys.inboundFirst, { [PHONE]: NOW - 4 * 60_000 });

    routed.mockResolvedValueOnce({ kind: 'retry-later', reason: 'no-quo-contact' });
    const first = await runInboundTick(deps);
    expect(first.mode).toBe('live');
    expect(first.entries[0].acted).toEqual([{ route: 'decline', outcome: 'retry-later', reason: 'no-quo-contact' }]);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBe(NOW + 2 * 60_000);
    expect(await redis.hget(keys.inboundFirst, PHONE)).toBe(NOW - 4 * 60_000);

    deps.now = () => NOW + 2 * 60_000;
    const second = await runInboundTick(deps);
    expect(second.entries[0]).toMatchObject({ outcome: 'unchanged', acted: [{ route: 'decline', outcome: 'drafted' }] });
    expect(prompts).toHaveLength(1);
    expect(await redis.zscore(keys.inboundDue, PHONE)).toBeNull();
  });

  it('sweepInbound arms phones with a customer message newer than the saved read, and nothing else', async () => {
    const at = (m: number) => new Date(NOW - m * 60_000).toISOString();
    const { deps, redis } = makeDeps({ messages: [] });
    const conv = (p: string, lastMin: number) => ({ participants: [p], lastActivityAt: at(lastMin) });
    const threads: Record<string, Array<{ direction: string; createdAt: string }>> = {
      '+15085550001': [{ direction: 'incoming', createdAt: at(30) }], // missed webhook, never read
      '+15085550002': [{ direction: 'incoming', createdAt: at(90) }, { direction: 'outgoing', createdAt: at(20) }], // Matt texted after the read
      '+15085550003': [{ direction: 'incoming', createdAt: at(40) }], // read since
    };
    deps.quo = {
      listConversations: async () => ({
        data: [conv('+15085550001', 30), conv('+15085550002', 20), conv('+15085550003', 40), conv('+16177660151', 5)],
      }),
      listMessages: async ({ participantE164 }: { participantE164: string }) => ({ data: threads[participantE164] ?? [] }),
      listCalls: async () => ({ data: [] }),
    } as unknown as RouterDeps['quo'];
    await redis.set(keys.inboundRead('+15085550002'), JSON.stringify(read({ at: at(60) })));
    await redis.set(keys.inboundRead('+15085550003'), JSON.stringify(read({ at: at(35) })));

    expect(await sweepInbound(deps)).toEqual(['+15085550001']);
    expect(await redis.zscore(keys.inboundDue, '+15085550001')).toBe(NOW);
    expect(await redis.hget(keys.inboundFirst, '+15085550001')).toBe(NOW - 30 * 60_000);
  });
});
