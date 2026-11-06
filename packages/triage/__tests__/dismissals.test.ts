import { describe, it, expect } from 'vitest';
import { MemoryTriageStore, addDismissal, isRuleActive, removeDismissal, validateDismissalRule } from '../src/index.js';

const TODAY = '2026-11-05';

describe('validateDismissalRule', () => {
  it('accepts the shape analyze reads', () => {
    const rule = { match: 'Forristall', sections: ['quote_gap'], reason: 'Do not chase.', addedAt: '2026-09-03', until: '2026-12-01' };
    expect(validateDismissalRule(rule)).toEqual(rule);
    expect(validateDismissalRule({ match: '+16175550100' })).toEqual({ match: '+16175550100' });
  });

  it('rejects bad fields with every problem listed', () => {
    expect(() => validateDismissalRule({ match: ' ', sections: ['nope'], until: '2026-13-01', extra: 1 })).toThrow(
      /unknown field "extra".*match must be a non-empty string.*unknown section "nope".*until must be YYYY-MM-DD/,
    );
    expect(() => validateDismissalRule({ match: 'A', sections: [] })).toThrow(/sections must be a non-empty array/);
    expect(() => validateDismissalRule('A')).toThrow(/must be an object/);
  });
});

describe('addDismissal / removeDismissal', () => {
  it('adds to an empty store with addedAt defaulted, and refuses a duplicate match + sections', async () => {
    const store = new MemoryTriageStore();
    await addDismissal(store, { match: 'Mettlach', sections: ['cash_not_sent'], reason: 'hold', until: '2026-11-20' }, TODAY);
    expect(store.dismissals).toEqual([{ match: 'Mettlach', sections: ['cash_not_sent'], reason: 'hold', until: '2026-11-20', addedAt: TODAY }]);
    await expect(addDismissal(store, { match: 'mettlach', sections: ['cash_not_sent'] }, TODAY)).rejects.toThrow(/already exists/);
    // Same match, different sections is a different rule.
    await addDismissal(store, { match: 'Mettlach', reason: 'all sections' }, TODAY);
    expect(store.dismissals).toHaveLength(2);
  });

  it('does not write an invalid rule', async () => {
    const store = new MemoryTriageStore();
    store.dismissals = [{ match: 'A' }];
    await expect(addDismissal(store, { match: 'B', sections: ['bogus'] }, TODAY)).rejects.toThrow(/unknown section/);
    expect(store.dismissals).toEqual([{ match: 'A' }]);
  });

  it('removes by match (case-insensitive), optionally narrowed to exact sections', async () => {
    const store = new MemoryTriageStore();
    store.dismissals = [
      { match: 'Hurley', sections: ['quote_gap'] },
      { match: 'Hurley' },
      { match: 'Parnaby', sections: ['quote_gap'] },
    ];
    expect(await removeDismissal(store, 'hurley', ['quote_gap'])).toEqual([{ match: 'Hurley', sections: ['quote_gap'] }]);
    expect(await removeDismissal(store, 'HURLEY')).toEqual([{ match: 'Hurley' }]);
    expect(store.dismissals).toEqual([{ match: 'Parnaby', sections: ['quote_gap'] }]);
    await expect(removeDismissal(store, 'Hurley')).rejects.toThrow(/no dismissal matches/);
    expect(store.dismissals).toEqual([{ match: 'Parnaby', sections: ['quote_gap'] }]);
  });

  it('treats until as inclusive, like analyze', () => {
    expect(isRuleActive({ match: 'A', until: TODAY }, TODAY)).toBe(true);
    expect(isRuleActive({ match: 'A', until: '2026-11-04' }, TODAY)).toBe(false);
    expect(isRuleActive({ match: 'A' }, TODAY)).toBe(true);
  });
});
