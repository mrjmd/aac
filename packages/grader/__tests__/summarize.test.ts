import { describe, it, expect } from 'vitest';
import { BAR, provenPct, summarize, type GradedDraft, type HandGrade } from '../src/index.js';

const d = (id: string, over: Partial<GradedDraft>): GradedDraft => ({
  id, automation: 'quote', kind: 'one-crack', path: 'fast', draftedAt: '2026-11-02T15:00:00Z', grade: 'as-is', ...over,
});

describe('provenPct', () => {
  it('is the one-sided 95% Wilson lower bound', () => {
    expect(provenPct(0, 0)).toBe(0);
    expect(provenPct(25, 25)).toBe(90);
    expect(provenPct(24, 24)).toBe(89);
    expect(provenPct(10, 24)).toBeLessThan(30);
  });
});

describe('summarize', () => {
  it('counts right (as-is, cosmetic) of graded; skips waiting and unused', () => {
    const s = summarize([
      d('a', {}), d('b', { grade: 'cosmetic' }), d('c', { grade: 'changed' }), d('e', { grade: 'thrown-out' }),
      d('f', { grade: 'waiting' }), d('g', { grade: 'unused' }),
    ], {}).get('quote')!;
    expect(s).toMatchObject({ k: 2, n: 4, raw: 50, drafts: 6, waiting: 1, unused: 1, hurt: 0 });
    expect(s.recent.map((r) => r.outcome)).toEqual(['right', 'right', 'changed', 'thrown-out', 'waiting', 'unused']);
  });

  it('hand grades override, and only they can say hurt; hurt counts in the last 50 only', () => {
    const many = Array.from({ length: 60 }, (_, i) => d(`q${i}`, { draftedAt: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00Z` }));
    const hand: Record<string, HandGrade> = { q0: { grade: 'hurt', at: 'x' }, q59: { grade: 'changed', at: 'x' } };
    const s = summarize(many, hand).get('quote')!;
    expect(s).toMatchObject({ n: 60, k: 58, hurt: 0, handGraded: 2 }); // q0 is the oldest, outside the last 50
    const s2 = summarize(many, { q59: { grade: 'hurt', at: 'x' } }).get('quote')!;
    expect(s2.hurt).toBe(1);
    expect(s2.kinds[0].qualifies).toBe(false);
  });

  it('per kind: fast first, qualifies only past the bar, human never', () => {
    const fast = Array.from({ length: 30 }, (_, i) => d(`f${i}`, {}));
    const human = Array.from({ length: 30 }, (_, i) => d(`h${i}`, { kind: 'structural', path: 'human' }));
    const s = summarize([...human, ...fast, d('x', { kind: 'floor', path: 'learn', grade: 'changed' })], {}).get('quote')!;
    expect(s.kinds.map((k) => [k.kind, k.qualifies, k.toBar])).toEqual([['one-crack', true, 0], ['floor', false, 41], ['structural', false, 0]]);
    expect(BAR.proven).toBe(90);
  });

  it('right in a row to the bar, and weeks by Monday', () => {
    const s = summarize([d('a', { draftedAt: '2026-11-04T12:00:00Z' }), d('b', { grade: 'changed', draftedAt: '2026-11-08T12:00:00Z' })], {}).get('quote')!;
    expect(s.toBar).toBeGreaterThan(25);
    expect(s.weeks).toEqual([{ week: '2026-11-02', right: 1, changed: 1, out: 0 }]);
    expect(s.since).toBe('2026-11-04T12:00:00Z');
  });
});
