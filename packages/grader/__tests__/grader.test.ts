import { describe, it, expect, vi } from 'vitest';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import { keys } from '@aac/shared-utils/redis';
import {
  collectDrafts,
  gradeQuote,
  gradeText,
  hasOpenQuestion,
  messageDrafts,
  quoteDrafts,
  quoteKind,
  runGrader,
  similarity,
  staleDrafts,
  type GradedDraft,
  type GraderDeps,
} from '../src/index.js';

const T0 = Date.parse('2026-11-01T15:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const msg = (direction: 'incoming' | 'outgoing', text: string, at: number): QuoMessage => ({
  id: `m${at}`, to: [], from: '', text, phoneNumberId: 'PN', direction, status: 'delivered', createdAt: iso(at), updatedAt: iso(at),
});
const call = (direction: 'incoming' | 'outgoing', duration: number, at: number): QuoCall => ({
  id: `c${at}`, to: '', from: '', phoneNumberId: 'PN', direction, status: 'completed', duration, createdAt: iso(at),
});
const line = (name: string, qty: number, unitPrice: number) => ({
  Amount: qty * unitPrice, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1', name }, Qty: qty, UnitPrice: unitPrice },
});
const est = (over: Partial<QBEstimate>): QBEstimate =>
  ({ Id: '10', SyncToken: '3', CustomerRef: { value: '1' }, Line: [], TxnStatus: 'Pending', ...over }) as QBEstimate;

describe('quoteKind', () => {
  it('reads the kind of case from the drafted lines', () => {
    expect(quoteKind([{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }, { item: 'Guarantee', qty: 1, unitPrice: 0 }])).toEqual({ kind: 'one-crack', path: 'fast' });
    expect(quoteKind([{ item: 'Crack Repair', qty: 2, unitPrice: 1175 }]).kind).toBe('cracks');
    expect(quoteKind([{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }, { item: 'Tie hole injections', qty: 3, unitPrice: 125 }])).toEqual({ kind: 'cracks-plus', path: 'learn' });
    expect(quoteKind([{ item: 'Bulkhead Injection', qty: 1, unitPrice: 1900 }]).kind).toBe('bulkhead');
    expect(quoteKind([{ item: 'Sewer Inlet Injection', qty: 1, unitPrice: 775 }]).kind).toBe('pipes');
    expect(quoteKind([{ item: 'Concrete floor crack', qty: 1, unitPrice: 675 }]).kind).toBe('floor');
    expect(quoteKind([{ item: 'Concrete Stair Resurfacing', qty: 1, unitPrice: 1700 }])).toEqual({ kind: 'steps', path: 'learn' });
    expect(quoteKind([{ item: 'Concrete Resurfacing', qty: 1, unitPrice: 2400 }])).toEqual({ kind: 'flat-resurfacing', path: 'human' });
    expect(quoteKind([{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }, { item: 'Carbon Fiber Staple(s)', qty: 2, unitPrice: 150 }]).kind).toBe('structural');
    expect(quoteKind([{ item: 'Fieldstone Injection', qty: 1, unitPrice: 1500 }]).kind).toBe('masonry');
    expect(quoteKind([{ item: 'Something New', qty: 1, unitPrice: 1 }]).kind).toBe('mixed');
  });
});

describe('gradeQuote', () => {
  const lines = [{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }];
  const base = { lines, total: 1175, draftedAt: iso(T0), now: T0 + DAY };

  it('deleted is thrown out; never emailed is waiting, then unused', () => {
    expect(gradeQuote({ ...base, current: null }).grade).toBe('thrown-out');
    expect(gradeQuote({ ...base, current: est({ Line: [line('Crack Repair', 1, 1175)] }) }).grade).toBe('waiting');
    expect(gradeQuote({ ...base, now: T0 + 31 * DAY, current: est({}) }).grade).toBe('unused');
    expect(gradeQuote({ ...base, current: est({ TxnStatus: 'Closed' }) }).grade).toBe('unused');
  });

  it('emailed with the same lines is as-is, ignoring the Guarantee line the drafter adds', () => {
    const current = est({ EmailStatus: 'EmailSent', TotalAmt: 1175, Line: [line('Crack Repair', 1, 1175), line('Guarantee', 1, 0)] as QBEstimate['Line'] });
    expect(gradeQuote({ ...base, current })).toEqual({ grade: 'as-is', sentTotal: 1175 });
    expect(gradeQuote({ ...base, current: { ...current, EmailStatus: 'NotSet', TxnStatus: 'Accepted' } }).grade).toBe('as-is');
  });

  it('a price, quantity or item change is changed, owner-relative', () => {
    const current = est({ EmailStatus: 'EmailSent', TotalAmt: 1075, Line: [line('Crack Repair', 1, 1075)] as QBEstimate['Line'] });
    const g = gradeQuote({ ...base, current });
    expect(g.grade).toBe('changed');
    expect(g.changes).toEqual(['owner CHANGED Crack Repair: ×1 @ $1075 ← ×1 @ $1175']);
    const added = est({ EmailStatus: 'EmailSent', TotalAmt: 1350, Line: [line('Crack Repair', 1, 1175), line('Sheetrock / Paneling Removal', 1, 175)] as QBEstimate['Line'] });
    expect(gradeQuote({ ...base, current: added }).changes).toEqual(['owner ADDED Sheetrock / Paneling Removal']);
  });

  it('a total change the line diff misses (two lines of one item) is still changed', () => {
    const current = est({ EmailStatus: 'EmailSent', TotalAmt: 2050, Line: [line('Crack Repair', 1, 875)] as QBEstimate['Line'] });
    const g = gradeQuote({ ...base, lines: [{ item: 'Crack Repair', qty: 1, unitPrice: 875 }], total: 2350, current });
    expect(g).toMatchObject({ grade: 'changed', note: 'total 2350 → 2050' });
  });
});

describe('gradeText', () => {
  const draft = 'Hi Ellen, I just sent that quote over to your email. Happy to answer any questions.';
  const base = { automation: 'followup' as const, draft, draftedAt: iso(T0), calls: [] as QuoCall[], now: T0 + 4 * DAY };

  it('scores word similarity', () => {
    expect(similarity(draft, draft)).toBe(1);
    expect(similarity('-- Matt at Attack A Crack\nhello there', 'Hello there!')).toBe(1);
    expect(similarity('a b c d', 'a b x d')).toBe(0.75);
  });

  it('sent as drafted is as-is; light edits cosmetic; a rewrite changed', () => {
    expect(gradeText({ ...base, messages: [msg('outgoing', draft, T0 + 5 * MIN)] })).toMatchObject({ grade: 'as-is', similarity: 1, sentAt: iso(T0 + 5 * MIN) });
    const light = draft.replace('Happy to', 'Glad to');
    expect(gradeText({ ...base, messages: [msg('outgoing', light, T0 + MIN)] }).grade).toBe('cosmetic');
    expect(gradeText({ ...base, messages: [msg('outgoing', 'Thanks Ellen, the quote is in your inbox, call me with questions about the drain pipe.', T0 + MIN)] }).grade).toBe('changed');
  });

  it('joins a reply split over several texts, and skips automated texts', () => {
    const [a, b] = [draft.slice(0, 52), draft.slice(52)];
    const messages = [
      msg('outgoing', 'Thanks for reaching out to Attack A Crack! Apologies for missing your call, we are on the line.', T0 + MIN),
      msg('outgoing', a, T0 + 2 * MIN),
      msg('outgoing', b, T0 + 3 * MIN),
      msg('outgoing', 'Later, unrelated text', T0 + 2 * DAY),
    ];
    expect(gradeText({ ...base, messages })).toMatchObject({ grade: 'as-is', sentAt: iso(T0 + 2 * MIN) });
  });

  it('nothing sent is waiting inside the window, unused after; a call first is unused', () => {
    expect(gradeText({ ...base, messages: [], now: T0 + DAY }).grade).toBe('waiting');
    expect(gradeText({ ...base, messages: [msg('outgoing', draft, T0 - MIN)] })).toMatchObject({ grade: 'unused', note: 'nothing texted within 72h' });
    const calls = [call('outgoing', 300, T0 + MIN)];
    expect(gradeText({ ...base, calls, messages: [msg('outgoing', draft, T0 + 10 * MIN)] })).toMatchObject({ grade: 'unused', note: 'called them before any text' });
    expect(gradeText({ ...base, calls: [call('incoming', 10, T0 + MIN)], messages: [msg('outgoing', draft, T0 + 10 * MIN)] }).grade).toBe('as-is');
  });

  it('open question: the customer asked something after Matt last texted', () => {
    expect(hasOpenQuestion([msg('outgoing', 'Send photos', T0 - 60 * MIN), msg('incoming', 'Here you go', T0 - 30 * MIN)], iso(T0))).toBe(false);
    expect(hasOpenQuestion([msg('outgoing', 'Send photos', T0 - 60 * MIN), msg('incoming', 'Is it structural?', T0 - 30 * MIN)], iso(T0))).toBe(true);
    expect(hasOpenQuestion([msg('incoming', 'Is it structural?', T0 - 60 * MIN), msg('outgoing', 'No', T0 - 30 * MIN)], iso(T0))).toBe(false);
    expect(hasOpenQuestion([msg('incoming', 'Is it structural?', T0 + MIN)], iso(T0))).toBe(false);
  });
});

describe('collect', () => {
  it('reads live quote drafts, a later update winning', () => {
    const rec = (at: string, total: number, outcome = 'created', mode = 'live') =>
      JSON.stringify({ at, mode, record: { outcome, estimateId: '3779', docNumber: '1592', phone: '+1', total, lines: [{ item: 'Crack Repair', qty: 2, unitPrice: total / 2 }] } });
    const out = quoteDrafts([rec('2026-11-06T02:00:00Z', 2000, 'updated'), rec('2026-11-06T01:00:00Z', 2350), rec('2026-11-06T03:00:00Z', 9, 'created', 'shadow'), { at: 'x', mode: 'live' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'quote:3779', kind: 'cracks', total: 2000, draftedAt: '2026-11-06T02:00:00Z' });
  });

  it('reads drafted text runlog rows and stale-quote touches', () => {
    const md = messageDrafts([
      { at: '2026-11-05T20:00:00Z', type: 'followup', estimateId: '3774', doc: '1588', phone: '+1', outcome: 'drafted', draft: 'x' },
      { at: '2026-11-05T21:00:00Z', type: 'intake', phone: '+2', outcome: 'drafted', draft: 'y', verdict: 'can-help' },
      { at: '2026-11-05T22:00:00Z', type: 'intake', phone: '+3', outcome: 'matt-replied' },
    ]);
    expect(md.map((d) => [d.id, d.kind])).toEqual([['followup:3774', 'all'], ['intake:+2:2026-11-05T21:00:00Z', 'can-help']]);
    const st = staleDrafts({ '2670': { estimateId: '2670', doc: '1503', phone: '+4', touches: [{ tier: 'T3', queuedAt: '2026-11-06T12:00:00Z', draft: 'z' }] } });
    expect(st[0]).toMatchObject({ id: 'stale-quote:2670:T3:2026-11-06T12:00:00Z', kind: 'T3', path: 'learn', phone: '+4' });
  });
});

describe('runGrader', () => {
  function fakeRedis(stored: Record<string, GradedDraft> = {}) {
    const hash: Record<string, unknown> = { ...stored };
    const lists: Record<string, unknown[]> = {
      [keys.quoteDrafterRunlog]: [{ at: iso(T0), mode: 'live', record: { outcome: 'created', estimateId: '10', phone: '+1', total: 1175, lines: [{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }] } }],
      [keys.messageDraftRunlog]: [{ at: iso(T0), type: 'followup', estimateId: '10', phone: '+1', outcome: 'drafted', draft: 'Hi, I just sent that quote over.' }],
    };
    const redis = {
      lrange: vi.fn(async (k: string) => lists[k] ?? []),
      hgetall: vi.fn(async (k: string) => (k === keys.graderDrafts ? hash : null)),
      hset: vi.fn(async (_k: string, o: Record<string, string>) => Object.assign(hash, o)),
    };
    return { redis, hash };
  }
  const deps = (redis: unknown, estimate: QBEstimate | null | Error): GraderDeps => ({
    redis: redis as GraderDeps['redis'],
    qb: { getEstimate: vi.fn(async () => { if (estimate instanceof Error) throw estimate; return estimate; }) },
    quo: {
      listMessages: vi.fn(async () => ({ data: [msg('outgoing', 'Hi, I just sent that quote over.', T0 + MIN)] })),
      listCalls: vi.fn(async () => ({ data: [] })),
    } as unknown as GraderDeps['quo'],
  });

  it('copies new drafts in and grades them', async () => {
    const { redis, hash } = fakeRedis();
    const sent = est({ EmailStatus: 'EmailSent', TotalAmt: 1175, Line: [line('Crack Repair', 1, 1175)] as QBEstimate['Line'] });
    const r = await runGrader(deps(redis, sent), { dryRun: false, deadlineMs: Date.now() + 60_000, now: T0 + 4 * DAY });
    expect(r).toMatchObject({ found: 2, added: 2, graded: 2, errors: 0, partial: false });
    expect(r.byGrade['as-is']).toBe(2);
    const fu = JSON.parse(hash['followup:10'] as string) as GradedDraft;
    expect(fu).toMatchObject({ grade: 'as-is', kind: 'quiet', path: 'fast', similarity: 1 });
  });

  it('dry run writes nothing; graded records are not re-graded', async () => {
    const { redis } = fakeRedis();
    await runGrader(deps(redis, null), { dryRun: true, deadlineMs: Date.now() + 60_000, now: T0 + 4 * DAY });
    expect(redis.hset).not.toHaveBeenCalled();

    const done = { id: 'quote:10', automation: 'quote', kind: 'one-crack', path: 'fast', draftedAt: iso(T0), grade: 'changed' } as GradedDraft;
    const second = fakeRedis({ 'quote:10': done });
    const d = deps(second.redis, null);
    const r = await runGrader(d, { dryRun: false, deadlineMs: Date.now() + 60_000, now: T0 + 4 * DAY });
    expect(d.qb.getEstimate).not.toHaveBeenCalled();
    expect(r.added).toBe(1);
    expect(second.hash['quote:10']).toBe(done);
  });

  it('a deleted estimate (QBO 610) is thrown out; other errors leave it waiting', async () => {
    const a = fakeRedis();
    await runGrader(deps(a.redis, new Error('QuickBooks API error: 400 - Object Not Found 610')), { dryRun: false, deadlineMs: Date.now() + 60_000, now: T0 + DAY });
    expect(JSON.parse(a.hash['quote:10'] as string).grade).toBe('thrown-out');
    const b = fakeRedis();
    const r = await runGrader(deps(b.redis, new Error('timeout')), { dryRun: false, deadlineMs: Date.now() + 60_000, now: T0 + DAY });
    expect(r.errors).toBe(1);
    expect(JSON.parse(b.hash['quote:10'] as string).grade).toBe('waiting');
  });

  it('stops at the deadline', async () => {
    const { redis } = fakeRedis();
    const r = await runGrader(deps(redis, null), { dryRun: false, deadlineMs: 0, now: T0 + DAY });
    expect(r).toMatchObject({ partial: true, graded: 0, added: 2 });
  });

  it('collectDrafts reads all three sources', async () => {
    const { redis } = fakeRedis();
    expect((await collectDrafts(redis as unknown as GraderDeps['redis'])).map((d) => d.id)).toEqual(['quote:10', 'followup:10']);
  });
});
