/**
 * Booking-sync outcome markers (keys.bookingSyncEvent) carry a TTL either
 * way: a day for `none` / `ambiguous` (re-checked tomorrow), a year for a
 * final outcome. The sync only reads events starting in the next 60 days,
 * so a year-old final marker is never read again; without a TTL one key
 * per booked job piled up forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisSet = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => ({ set: redisSet })),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

vi.mock('../lib/clients.js', () => ({ getCalendar: vi.fn() }));

import { keys, ttl } from '@aac/shared-utils/redis';
import { BOOKED_LOOKAHEAD_DAYS } from '../lib/booked-events.js';
import { setBookingSyncOutcome } from '../lib/redis.js';

describe('setBookingSyncOutcome', () => {
  beforeEach(() => {
    redisSet.mockReset();
  });

  it('sets the one-year TTL on a final outcome', async () => {
    await setBookingSyncOutcome('evt1', 'covered:1503', true);
    expect(redisSet).toHaveBeenCalledWith(keys.bookingSyncEvent('evt1'), 'covered:1503', { ex: ttl.bookingSyncFinal });
  });

  it('keeps the one-day TTL on a non-final outcome', async () => {
    await setBookingSyncOutcome('evt2', 'none', false);
    expect(redisSet).toHaveBeenCalledWith(keys.bookingSyncEvent('evt2'), 'none', { ex: 86_400 });
  });

  it('outlives the lookahead window the sync reads by a wide margin', () => {
    expect(ttl.bookingSyncFinal).toBeGreaterThan(5 * BOOKED_LOOKAHEAD_DAYS * 86_400);
  });
});
