import { describe, it, expect } from 'vitest';
import { buildCanHelpBlock, isRuleActive, CanHelpStore, type StandingRule, type Referral } from '../src/can-help';

const referrals: Referral[] = [{ id: 'best', name: 'Henry at Best Bulkheads', phone: '(781) 801-8188', sends: 'bulkhead doors and replacement' }];
const rules: StandingRule[] = [
  { id: 'block', kind: 'decline', text: 'Leaking cinder block walls', referralIds: ['best', 'missing'], since: '2026-11-04' },
  { id: 'resurf', kind: 'policy', text: 'No large resurfacing', since: '2026-10-21', untilWhen: 'tech #2 starts' },
  { id: 'old', kind: 'policy', text: 'Expired thing', since: '2026-01-01', until: '2026-02-01' },
];

describe('can-help', () => {
  it('isRuleActive honours since and until', () => {
    expect(isRuleActive(rules[0]!, '2026-11-03')).toBe(false);
    expect(isRuleActive(rules[0]!, '2026-11-04')).toBe(true);
    expect(isRuleActive(rules[2]!, '2026-11-04')).toBe(false);
  });

  it('builds the prompt block with referrals, end conditions, and no expired rules', () => {
    const block = buildCanHelpBlock({ rules, referrals, today: '2026-11-04' });
    expect(block).toContain('- Leaking cinder block walls → refer: Henry at Best Bulkheads (781) 801-8188');
    expect(block).toContain('No large resurfacing (until tech #2 starts)');
    expect(block).not.toContain('Expired thing');
    expect(block).toContain('- Henry at Best Bulkheads (781) 801-8188: bulkhead doors and replacement');
  });

  it('store round-trips through a hash', async () => {
    const h: Record<string, Record<string, unknown>> = {};
    const redis = {
      hgetall: async <T,>(k: string) => (h[k] ?? null) as T | null,
      hset: async <T,>(k: string, kv: Record<string, T>) => { h[k] = { ...(h[k] ?? {}), ...kv }; return 1; },
      hdel: async (k: string, ...f: string[]) => { for (const x of f) delete h[k]?.[x]; return f.length; },
    };
    const store = new CanHelpStore(redis);
    await store.putReferral(referrals[0]!);
    await store.putRule(rules[0]!);
    expect(await store.block('2026-11-04')).toContain('Henry at Best Bulkheads');
    await store.removeRule('block');
    expect(await store.rules()).toHaveLength(0);
  });
});
