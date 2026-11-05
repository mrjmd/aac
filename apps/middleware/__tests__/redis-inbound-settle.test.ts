/**
 * Inbound router settle clock: the first event of a burst is remembered
 * (HSETNX) and the phone is scored at min(now + 2 min, first + 10 min).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const first = new Map<string, number>();
const zadd = vi.fn();
const hsetnx = vi.fn(async (_key: string, field: string, value: number) => {
  if (first.has(field)) return 0;
  first.set(field, value);
  return 1;
});
const hget = vi.fn(async (_key: string, field: string) => first.get(field) ?? null);

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => ({ hsetnx, hget, zadd })),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

import { scheduleInboundSettle } from '../lib/redis.js';

const T0 = Date.parse('2026-11-05T15:00:00Z');
const PHONE = '+19785550199';

describe('scheduleInboundSettle', () => {
  beforeEach(() => {
    first.clear();
    zadd.mockReset();
  });

  it('first text: due 2 min later', async () => {
    await scheduleInboundSettle(PHONE, T0);
    expect(hsetnx).toHaveBeenCalledWith('inbound:first', PHONE, T0);
    expect(zadd).toHaveBeenCalledWith('inbound:due', { score: T0 + 120_000, member: PHONE });
  });

  it('later texts push it out, but never past first + 10 min', async () => {
    await scheduleInboundSettle(PHONE, T0);
    await scheduleInboundSettle(PHONE, T0 + 5 * 60_000);
    expect(zadd).toHaveBeenLastCalledWith('inbound:due', { score: T0 + 7 * 60_000, member: PHONE });
    await scheduleInboundSettle(PHONE, T0 + 9 * 60_000);
    expect(zadd).toHaveBeenLastCalledWith('inbound:due', { score: T0 + 10 * 60_000, member: PHONE });
    expect(first.get(PHONE)).toBe(T0);
  });

  it('never throws', async () => {
    zadd.mockRejectedValueOnce(new Error('redis down'));
    await expect(scheduleInboundSettle(PHONE, T0)).resolves.toBeUndefined();
  });
});
