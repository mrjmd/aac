/**
 * PD↔QB id-mapping reads must return strings regardless of how Upstash
 * deserializes the stored value. Upstash JSON-parses on read, so a stored
 * "2270" round-trips as the number 2270 — which crashed QB query escaping
 * (`customerId.replace is not a function`) inside a fail-open catch and
 * silently capped every Quo-path quote_approved directive at 0.69
 * confidence (Michelle Offley, 2026-10-20).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisGet = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => ({ get: redisGet })),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

import { getQbCustomerIdFromPipedrive, getPipedriveIdFromQb } from '../lib/redis.js';

describe('PD↔QB id mapping reads', () => {
  beforeEach(() => {
    redisGet.mockReset();
  });

  it('returns a string when Upstash deserializes the value to a number', async () => {
    redisGet.mockResolvedValue(2270);
    await expect(getQbCustomerIdFromPipedrive('6348')).resolves.toBe('2270');

    redisGet.mockResolvedValue(6348);
    await expect(getPipedriveIdFromQb('2270')).resolves.toBe('6348');
  });

  it('passes string values through unchanged', async () => {
    redisGet.mockResolvedValue('2270');
    await expect(getQbCustomerIdFromPipedrive('6348')).resolves.toBe('2270');
  });

  it('returns null for missing mappings', async () => {
    redisGet.mockResolvedValue(null);
    await expect(getQbCustomerIdFromPipedrive('6348')).resolves.toBeNull();
    await expect(getPipedriveIdFromQb('2270')).resolves.toBeNull();
  });
});
