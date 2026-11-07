import { describe, it, expect } from 'vitest';
import {
  applyVerb,
  dismissalPatterns,
  groupByPerson,
  PROMOTION_DEFAULTS,
  rankFeatures,
  rankItem,
  reconcile,
  shouldSuggest,
  SUGGEST_MAX,
  type ItemCandidate,
} from '../src/index.js';

const NOW = new Date('2026-11-05T15:00:00Z'); // 10am ET
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function cand(key: string, over: Partial<ItemCandidate> = {}): ItemCandidate {
  return {
    key,
    detector: 'L1',
    area: 'inbox',
    lane: 'needs-you',
    severity: 'yellow',
    title: key,
    customer: key,
    fingerprint: 'fp',
    ...over,
  };
}

describe('rankItem', () => {
  it('puts a promise due today above a customer waiting, above dollars', () => {
    const due = rankItem(cand('call', { dueAt: hoursFromNow(4) }), NOW);
    const waiting = rankItem(cand('wait', { waitingSince: daysAgo(1) }), NOW);
    const money = rankItem(cand('inv', { detector: 'D3', severity: 'red', amount: 7800 }), NOW);
    expect(due.score).toBeGreaterThan(waiting.score);
    expect(waiting.score).toBeGreaterThan(money.score);
    expect(due.why[0]).toBe('Due 2 PM today');
  });

  it('ranks an overdue promise above one due later today', () => {
    const overdue = rankItem(cand('a', { dueAt: hoursFromNow(-3) }), NOW);
    const later = rankItem(cand('b', { dueAt: hoursFromNow(6) }), NOW);
    expect(overdue.score).toBeGreaterThan(later.score);
    expect(overdue.why[0]).toMatch(/^Overdue/);
  });

  it('lets a fresh wait outrank a stale red one', () => {
    const stale = rankItem(cand('aw', { detector: 'AW', severity: 'red', waitingSince: daysAgo(137), amount: 5875 }), NOW);
    const fresh = rankItem(cand('l1', { waitingSince: daysAgo(0.5), amount: 900 }), NOW);
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it('sinks solicitations and batched stale quotes', () => {
    expect(rankItem(cand('s', { solicitation: true, severity: 'red' }), NOW).score).toBeLessThan(0);
    const d5 = rankItem(cand('q', { detector: 'D5', amount: 2000 }), NOW);
    const stub = rankItem(cand('st', { detector: 'D10' }), NOW);
    expect(d5.score).toBeLessThan(stub.score);
    expect(d5.why).toContain('In the follow-up batch');
  });
});

describe('suggestions on Today', () => {
  it('suggests deadlines and fresh waits above Matt’s pinned order', () => {
    const pinned = cand('mine', { detector: 'D10' });
    const due = cand('due', { dueAt: hoursFromNow(5) });
    const quiet = cand('quiet', { detector: 'D10', severity: 'info' });
    const first = reconcile([pinned, due, quiet], {}, [], NOW);
    const states = { ...first.states, mine: applyVerb(first.states.mine, { type: 'pin' }, pinned, NOW) };
    const r = reconcile([pinned, due, quiet], states, [], NOW);
    expect(r.items.map((i) => [i.key, i.band, !!i.suggested])).toEqual([
      ['due', 'today', true],
      ['mine', 'today', false],
      ['quiet', 'new', false],
    ]);
  });

  it('does not re-suggest an item Matt placed, until the customer writes again', () => {
    const c = cand('w', { waitingSince: daysAgo(0.2) });
    const first = reconcile([c], {}, [], NOW);
    expect(first.items[0].suggested).toBe(true);
    const placed = { w: applyVerb(first.states.w, { type: 'unpin' }, c, NOW) };
    expect(reconcile([c], placed, [], NOW).items[0].band).toBe('list');
    const again = { ...c, waitingSince: hoursFromNow(1) };
    expect(reconcile([again], placed, [], new Date(NOW.getTime() + 2 * 3_600_000)).items[0].suggested).toBe(true);
  });

  it(`caps suggestions at ${SUGGEST_MAX}`, () => {
    const many = Array.from({ length: SUGGEST_MAX + 3 }, (_, i) => cand(`c${i}`, { waitingSince: daysAgo(0.1) }));
    expect(reconcile(many, {}, [], NOW).items.filter((i) => i.suggested)).toHaveLength(SUGGEST_MAX);
  });
});

describe('groupByPerson', () => {
  it('folds one person’s items across phone, email and identity cluster', () => {
    const r = reconcile(
      [
        cand('l1:rob', { phone: '+16175951630', customer: 'Rob', waitingSince: daysAgo(2), who: { cluster: 'c1' } }),
        cand('qdfail:rob', { detector: 'QD', phone: '+16175951630', customer: undefined }),
        cand('l2:a', { detector: 'L2', customer: 'Rob', who: { emails: ['ron2122@verizon.net'], cluster: 'c1' } }),
        cand('l2:b', { detector: 'L2', customer: 'Ron', who: { emails: ['RON2122@verizon.net'] } }),
        cand('other', { phone: '+15550000000' }),
      ],
      {},
      [],
      NOW,
    );
    const rob = r.items.find((i) => i.key === 'l1:rob');
    expect(rob?.related?.map((i) => i.key).sort()).toEqual(['l2:a', 'l2:b', 'qdfail:rob']);
    expect(r.items).toHaveLength(2);
  });

  it('merges full names but not bare first names or "Lead (·1234)"', () => {
    const items = reconcile(
      [
        cand('a', { customer: 'Ellen Pompeo' }),
        cand('b', { customer: 'ellen pompeo' }),
        cand('c', { customer: 'Sarah' }),
        cand('d', { customer: 'Sarah' }),
        cand('e', { customer: 'Lead (·3964)' }),
        cand('f', { customer: 'Lead (·9735)' }),
      ],
      {},
      [],
      NOW,
    ).items;
    expect(items).toHaveLength(5);
  });

  it('never folds solicitations; confirm items fold under a needs-you lead only', () => {
    const out = reconcile(
      [
        cand('x', { phone: '+1', solicitation: true }),
        cand('y', { phone: '+1' }),
        cand('z', { detector: 'D15', phone: '+1', lane: 'confirm' }),
        cand('c1', { phone: '+2', lane: 'confirm' }),
        cand('c2', { phone: '+2', lane: 'confirm' }),
      ],
      {},
      [],
      NOW,
    ).items;
    expect(out.map((i) => [i.key, (i.related ?? []).map((r) => r.key)])).toEqual(
      expect.arrayContaining([['y', ['z']], ['x', []], ['c1', []], ['c2', []]]),
    );
    expect(out).toHaveLength(4);
    expect(groupByPerson(out)).toHaveLength(4);
  });
});

describe('rankFeatures', () => {
  it('records the facts the ranking used', () => {
    const c = cand('f', { amount: 1900, dueAt: hoursFromNow(2), waitingSince: daysAgo(1) });
    const { states } = reconcile([c], {}, [], NOW);
    const f = rankFeatures(c, states.f, NOW);
    expect(f).toMatchObject({ key: 'f', detector: 'L1', amount: 1900, dueInHours: 2, waitingDays: 1, pinned: false });
    expect(f.score).toBe(rankItem(c, NOW).score);
  });
});

describe('promotion switches (Rules page)', () => {
  const state = { key: 'k', status: 'open' as const, firstSeenAt: daysAgo(1), lastSeenAt: NOW.toISOString() };
  const date = (due: string) => cand('ob:gl:' + due, { detector: 'DATE', area: 'admin', severity: 'info', customer: undefined, dueOn: `${due}T16:00:00.000Z` });

  it('puts an important date on Today 7 days out, not 8', () => {
    expect(shouldSuggest(date('2026-11-12'), state, 20, NOW)).toBe(true);
    expect(shouldSuggest(date('2026-11-13'), state, 20, NOW)).toBe(false);
    expect(shouldSuggest(date('2026-11-01'), state, 20, NOW)).toBe(true); // overdue
  });

  it('honors each switch', () => {
    const off = { ...PROMOTION_DEFAULTS };
    expect(shouldSuggest(cand('call', { dueAt: hoursFromNow(4) }), state, 1100, NOW, { ...off, deadlines: false, ranked: false })).toBe(false);
    expect(shouldSuggest(date('2026-11-06'), state, 20, NOW, { ...off, dates: false })).toBe(false);
    expect(shouldSuggest(cand('wait'), state, 500, NOW, { ...off, ranked: false })).toBe(false);
    expect(shouldSuggest(cand('wait'), state, 500, NOW)).toBe(true);
  });

  it('reconcile passes the switches through', () => {
    const c = [cand('call', { dueAt: hoursFromNow(4) })];
    expect(reconcile(c, {}, [], NOW).items[0]!.band).toBe('today');
    expect(reconcile(c, {}, [], NOW, { promote: { deadlines: false, dates: true, ranked: false } }).items[0]!.band).not.toBe('today');
  });
});

describe('dismissalPatterns', () => {
  const d = (key: string, detector: string, reason: 'wrong-match' | 'not-real') => ({
    key,
    status: 'dismissed' as const,
    firstSeenAt: daysAgo(3),
    lastSeenAt: daysAgo(1),
    dismissReason: reason,
    snapshot: { title: key, detector },
  });

  it('counts a reason repeated on one detector, most first, and drops one-offs', () => {
    const out = dismissalPatterns([d('a', 'S7', 'wrong-match'), d('b', 'S7', 'wrong-match'), d('c', 'S7', 'wrong-match'), d('e', 'D3', 'not-real'), d('f', 'D3', 'not-real'), d('g', 'L1', 'not-real')]);
    expect(out).toEqual([
      { detector: 'S7', reason: 'wrong-match', count: 3 },
      { detector: 'D3', reason: 'not-real', count: 2 },
    ]);
  });
});
