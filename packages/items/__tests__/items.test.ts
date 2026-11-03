import { describe, it, expect } from 'vitest';
import {
  applyVerb,
  ConfirmRequiredError,
  fromTriageFinding,
  recentlyDismissed,
  reconcile,
  reorderToday,
  staleStateKeys,
  triageFingerprint,
  type ItemCandidate,
  type ItemState,
  type MuteRule,
} from '../src/index.js';

const T0 = new Date('2026-11-03T14:00:00Z'); // 9am ET
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3_600_000);

function cand(over: Partial<ItemCandidate> = {}): ItemCandidate {
  return {
    key: 'd5:3766',
    detector: 'D5',
    area: 'sales',
    lane: 'needs-you',
    severity: 'yellow',
    title: 'Gene J — #1583',
    customer: 'Gene J',
    phone: '+16177676590',
    amount: 1900,
    fingerprint: 'fp1',
    ...over,
  };
}

function stateAfter(c: ItemCandidate, verb: Parameters<typeof applyVerb>[1], at = T0): Record<string, ItemState> {
  const { states } = reconcile([c], {}, [], at);
  return { [c.key]: applyVerb(states[c.key], verb, c, at) };
}

describe('reconcile', () => {
  it('creates state for a new candidate and puts it in the new band', () => {
    const r = reconcile([cand()], {}, [], T0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].band).toBe('new');
    expect(r.states['d5:3766']).toMatchObject({ status: 'open', firstSeenAt: T0.toISOString() });
  });

  it('baseline import starts everything placed, later arrivals are new', () => {
    const first = reconcile([cand({ key: 'a' })], {}, [], T0, { baseline: true });
    expect(first.items[0].band).toBe('list');
    const later = reconcile([cand({ key: 'a' }), cand({ key: 'b' })], first.states, [], hoursLater(1));
    expect(later.items.map((i) => [i.key, i.band])).toEqual([
      ['b', 'new'],
      ['a', 'list'],
    ]);
  });

  it('moves a placed item to the list band', () => {
    const states = stateAfter(cand(), { type: 'place' });
    expect(reconcile([cand()], states, [], hoursLater(1)).items[0].band).toBe('list');
  });

  it('keeps done items hidden while the fingerprint is unchanged', () => {
    const states = stateAfter(cand(), { type: 'done' });
    const r = reconcile([cand()], states, [], hoursLater(24));
    expect(r.items).toHaveLength(0);
    expect(r.hidden[0]).toMatchObject({ key: 'd5:3766', reason: 'done' });
  });

  it('reopens a done item into the new band when the evidence changes', () => {
    const states = stateAfter(cand(), { type: 'done' });
    const r = reconcile([cand({ fingerprint: 'fp2' })], states, [], hoursLater(24));
    expect(r.items[0].band).toBe('new');
    expect(r.items[0].state.reopenedAt).toBe(hoursLater(24).toISOString());
  });

  it('reopens a dismissed item only on material change', () => {
    const states = stateAfter(cand(), { type: 'dismiss', reason: 'not-real' });
    expect(reconcile([cand()], states, [], hoursLater(48)).items).toHaveLength(0);
    const r = reconcile([cand({ fingerprint: 'fp2' })], states, [], hoursLater(48));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].state.dismissReason).toBeUndefined();
  });

  it('brings a snoozed item back when the time passes or new evidence arrives', () => {
    const until = hoursLater(24).toISOString();
    const states = stateAfter(cand(), { type: 'snooze', until });
    expect(reconcile([cand()], states, [], hoursLater(23)).items).toHaveLength(0);
    expect(reconcile([cand()], states, [], hoursLater(24)).items).toHaveLength(1);
    expect(reconcile([cand({ fingerprint: 'fp2' })], states, [], hoursLater(1)).items).toHaveLength(1);
  });

  it('hides muted items by detector, optionally narrowed by a match', () => {
    const all: MuteRule = { id: 'm1', detector: 'd5', createdAt: T0.toISOString() };
    const gene: MuteRule = { id: 'm2', detector: 'D5', match: 'gene', createdAt: T0.toISOString() };
    const other: MuteRule = { id: 'm3', detector: 'D5', match: 'forristall', createdAt: T0.toISOString() };
    expect(reconcile([cand()], {}, [all], T0).hidden[0].reason).toBe('muted');
    expect(reconcile([cand()], {}, [gene], T0).items).toHaveLength(0);
    expect(reconcile([cand()], {}, [other], T0).items).toHaveLength(1);
  });

  it('orders Today by Matt’s rank and never ranks new items', () => {
    const a = cand({ key: 'a', severity: 'info' });
    const b = cand({ key: 'b', severity: 'red' });
    const c = cand({ key: 'c', severity: 'red' });
    let { states } = reconcile([a, b, c], {}, [], T0);
    states.a = applyVerb(states.a, { type: 'pin' }, a, T0);
    states.b = applyVerb(states.b, { type: 'pin' }, b, T0, [states.a.rank ?? 0]);
    states = { ...states, ...reorderToday(states, ['a', 'b']) };
    const r = reconcile([a, b, c], states, [], hoursLater(1));
    expect(r.items.map((i) => [i.key, i.band])).toEqual([
      ['a', 'today'],
      ['b', 'today'],
      ['c', 'new'],
    ]);
    expect(r.items[2].state.rank).toBeUndefined();
  });

  it('counts rollover days for items sitting on Today', () => {
    const states = stateAfter(cand(), { type: 'pin' });
    const r = reconcile([cand()], states, [], new Date('2026-11-06T14:00:00Z'));
    expect(r.items[0].rolloverDays).toBe(3);
  });

  it('shows an item pinned for a future day only once that day arrives', () => {
    const states = stateAfter(cand(), { type: 'pin', date: '2026-11-05' });
    expect(reconcile([cand()], states, [], T0).items[0].band).toBe('list');
    expect(reconcile([cand()], states, [], new Date('2026-11-05T13:00:00Z')).items[0].band).toBe('today');
  });

  it('carries through states for keys no detector emitted', () => {
    const states = stateAfter(cand(), { type: 'done' });
    const r = reconcile([], states, [], hoursLater(1));
    expect(r.states['d5:3766'].status).toBe('done');
  });
});

describe('verbs', () => {
  it('requires confirmation to dismiss a money item', () => {
    const money = cand({ key: 'd3:2368', area: 'money', sensitive: 'money' });
    const { states } = reconcile([money], {}, [], T0);
    expect(() => applyVerb(states['d3:2368'], { type: 'dismiss', reason: 'already-handled' }, money, T0)).toThrow(
      ConfirmRequiredError,
    );
    const ok = applyVerb(states['d3:2368'], { type: 'dismiss', reason: 'already-handled', confirmed: true }, money, T0);
    expect(ok.status).toBe('dismissed');
  });

  it('done takes an item off Today', () => {
    const pinned = stateAfter(cand(), { type: 'pin' })['d5:3766'];
    const done = applyVerb(pinned, { type: 'done' }, cand(), T0);
    expect(done.pinnedFor).toBeUndefined();
    expect(done.rank).toBeUndefined();
  });

  it('restore reopens a dismissed item as placed', () => {
    const dismissed = stateAfter(cand(), { type: 'dismiss', reason: 'other' })['d5:3766'];
    const restored = applyVerb(dismissed, { type: 'restore' }, cand(), hoursLater(1));
    expect(restored).toMatchObject({ status: 'open' });
    expect(restored.dismissReason).toBeUndefined();
    expect(reconcile([cand()], { [cand().key]: restored }, [], hoursLater(2)).items[0].band).toBe('list');
  });

  it('pin appends to the end of Today', () => {
    const s = reconcile([cand()], {}, [], T0).states['d5:3766'];
    expect(applyVerb(s, { type: 'pin' }, cand(), T0, [0, 4]).rank).toBe(5);
    expect(applyVerb(s, { type: 'pin' }, cand(), T0).pinnedFor).toBe('2026-11-03');
  });
});

describe('housekeeping', () => {
  it('lists recent dismissals newest first', () => {
    const a = stateAfter(cand({ key: 'a' }), { type: 'dismiss', reason: 'other' }, T0);
    const b = stateAfter(cand({ key: 'b' }), { type: 'dismiss', reason: 'other' }, hoursLater(2));
    expect(recentlyDismissed({ ...a, ...b }, hoursLater(3)).map((s) => s.key)).toEqual(['b', 'a']);
  });

  it('finds states unseen and untouched for 30 days', () => {
    const { states } = reconcile([cand()], {}, [], T0);
    expect(staleStateKeys(states, hoursLater(24 * 29))).toEqual([]);
    expect(staleStateKeys(states, hoursLater(24 * 31))).toEqual(['d5:3766']);
  });
});

describe('fromTriageFinding', () => {
  it('maps sections to areas, lanes and sensitivity', () => {
    const overdue = fromTriageFinding({
      id: 'd3:2368',
      section: 'cash_overdue',
      severity: 'red',
      title: 'Overdue 123d — Emanuel Markis (#2368)',
      customer: 'Emanuel Markis',
      amount: 7800,
      source: 'D3',
    });
    expect(overdue).toMatchObject({ key: 'd3:2368', detector: 'D3', area: 'money', lane: 'needs-you', sensitive: 'money' });
    const draft = fromTriageFinding({ id: 'md:1', section: 'message_draft', severity: 'yellow', title: 'x', source: 'D15' });
    expect(draft).toMatchObject({ area: 'inbox', lane: 'confirm' });
    expect(draft.sensitive).toBeUndefined();
  });

  it('keeps the fingerprint stable as ages tick', () => {
    const base = { id: 'd3:2368', section: 'cash_overdue', severity: 'red' as const, amount: 7800, source: 'D3' };
    const day1 = triageFingerprint({ ...base, title: 'Overdue 123d', detail: 'age 123' });
    const day2 = triageFingerprint({ ...base, title: 'Overdue 124d', detail: 'age 124' });
    expect(day1).toBe(day2);
    expect(triageFingerprint({ ...base, title: 'Overdue 124d', amount: 3900 })).not.toBe(day1);
  });
});
