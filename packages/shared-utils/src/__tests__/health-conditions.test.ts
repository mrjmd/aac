import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONDITIONS,
  ROLLING_CONDITIONS,
  countCondition,
  type ConditionRedis,
} from '../health.js';
import { keys, ttl } from '../redis.js';

/** In-memory hashes + sorted sets, recording TTLs. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
  const ttls = new Map<string, number>();
  const redis = {
    hincrby: vi.fn(async (key: string, field: string, increment: number) => {
      const h = hashes.get(key) ?? new Map<string, string>();
      const n = Number(h.get(field) ?? 0) + increment;
      h.set(field, String(n));
      hashes.set(key, h);
      return n;
    }),
    hset: vi.fn(async (key: string, kv: Record<string, string>) => {
      const h = hashes.get(key) ?? new Map<string, string>();
      for (const [f, v] of Object.entries(kv)) h.set(f, v);
      hashes.set(key, h);
      return Object.keys(kv).length;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
    zadd: vi.fn(async (key: string, ...members: Array<{ score: number; member: string }>) => {
      zsets.set(key, [...(zsets.get(key) ?? []), ...members]);
      return members.length;
    }),
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const before = zsets.get(key) ?? [];
      const after = before.filter((m) => m.score < min || m.score > max);
      zsets.set(key, after);
      return before.length - after.length;
    }),
  } satisfies ConditionRedis;
  return { redis, hashes, zsets, ttls };
}

// 23:30 UTC on Nov 5 is 6:30 PM Eastern on Nov 5; 03:30 UTC Nov 6 is still Nov 5 Eastern.
const NOW = new Date('2026-11-06T03:30:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('countCondition', () => {
  it('HINCRBYs health:conditions:{Eastern day} with a 14-day TTL', async () => {
    const f = fakeRedis();
    await countCondition(f.redis, 'reminders.no_phone');
    await countCondition(f.redis, 'reminders.no_phone');
    await countCondition(f.redis, 'quote-email.no_scope', { by: 3 });
    const key = 'health:conditions:2026-11-05';
    expect(keys.healthConditions('2026-11-05')).toBe(key);
    expect(f.hashes.get(key)?.get('reminders.no_phone')).toBe('2');
    expect(f.hashes.get(key)?.get('quote-email.no_scope')).toBe('3');
    expect(f.ttls.get(key)).toBe(1_209_600);
    expect(ttl.healthConditions).toBe(14 * 86_400);
  });

  it('records the entity as <name>|<id> → {label, at} on the same day, same TTL', async () => {
    const f = fakeRedis();
    await countCondition(f.redis, 'invoice-create.no_qb_customer', { entity: { id: 'evt1', label: 'Jane Doe · 12 Main St' } });
    const key = 'health:conditions:2026-11-05:entities';
    expect(JSON.parse(f.hashes.get(key)!.get('invoice-create.no_qb_customer|evt1')!)).toEqual({
      label: 'Jane Doe · 12 Main St',
      at: NOW.toISOString(),
    });
    expect(f.ttls.get(key)).toBe(1_209_600);
  });

  it('writes no entity hash without an entity', async () => {
    const f = fakeRedis();
    await countCondition(f.redis, 'followups.no_person');
    expect(f.redis.hset).not.toHaveBeenCalled();
  });

  it('keeps rolling conditions in a 2h ZSET, one member per occurrence, pruning older ones', async () => {
    const f = fakeRedis();
    const key = keys.healthConditionRecent('router.read_failed');
    f.zsets.set(key, [{ score: NOW.getTime() - 3 * 3_600_000, member: 'old' }]);
    await countCondition(f.redis, 'router.read_failed', { by: 2 });
    const members = f.zsets.get(key)!;
    expect(members.map((m) => m.score)).toEqual([NOW.getTime(), NOW.getTime()]);
    expect(new Set(members.map((m) => m.member)).size).toBe(2);
    expect(f.ttls.get(key)).toBe(7_200);
  });

  it('does not keep non-rolling conditions in a window', async () => {
    const f = fakeRedis();
    await countCondition(f.redis, 'booking-sync.error');
    expect(f.redis.zadd).not.toHaveBeenCalled();
  });

  it('never throws when Redis is down', async () => {
    const f = fakeRedis();
    f.redis.hincrby.mockRejectedValueOnce(new Error('ECONNRESET'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(countCondition(f.redis, 'dispatch.stub_skipped')).resolves.toBeUndefined();
    err.mockRestore();
  });

  it('rolling conditions are all registered, with a plain-English label each', () => {
    for (const n of ROLLING_CONDITIONS) expect(CONDITIONS[n]).toBeTruthy();
    for (const [name, label] of Object.entries(CONDITIONS)) {
      expect(name).toMatch(/^[a-z-]+\.[a-z_]+$/);
      expect(label.length).toBeGreaterThan(10);
    }
  });
});
