/**
 * lib/redis.ts health wrappers delegate to @aac/shared-utils/health with the
 * middleware's client: same keys and values the middleware always wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  set: vi.fn(async () => 'OK'),
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  lpush: vi.fn(async () => 1),
  ltrim: vi.fn(async () => 'OK'),
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => client),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

import { logHealthError, trackCronRun, trackWebhookProcessed } from '../lib/redis.js';

const NOW = new Date('2026-11-05T23:30:00.000Z');

describe('middleware health wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('trackWebhookProcessed counts and stamps the source', async () => {
    await trackWebhookProcessed('qb');
    expect(client.incr).toHaveBeenCalledWith('webhooks:qb:2026-11-05:count');
    expect(client.set).toHaveBeenCalledWith('webhooks:qb:last', NOW.toISOString());
    expect(client.expire).toHaveBeenCalledWith('webhooks:qb:2026-11-05:count', 172_800);
  });

  it('logHealthError pushes the JSON entry onto health:errors and caps it at 100', async () => {
    await logHealthError('cron:invoice-create', 'boom', { id: 1 });
    const [key, raw] = client.lpush.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('health:errors');
    expect(JSON.parse(raw)).toMatchObject({ source: 'cron:invoice-create', message: 'boom', details: { id: 1 }, timestamp: NOW.toISOString() });
    expect(client.ltrim).toHaveBeenCalledWith('health:errors', 0, 99);
  });

  it('trackCronRun stamps cron:{job}:last-run and the 30-day daily result', async () => {
    await trackCronRun('job-reminders', { sent: 2, skipped: 1, errors: 0 });
    expect(client.set).toHaveBeenCalledWith('cron:job-reminders:last-run', NOW.toISOString());
    expect(client.set).toHaveBeenCalledWith(
      'cron:job-reminders:2026-11-05:result',
      JSON.stringify({ sent: 2, skipped: 1, errors: 0 }),
      { ex: 2_592_000 },
    );
  });
});

describe('middleware countCondition wrapper', () => {
  it('HINCRBYs today\'s Eastern health:conditions hash and never throws', async () => {
    const hincrby = vi.fn(async () => 1);
    Object.assign(client, { hincrby, hset: vi.fn(async () => 1), zadd: vi.fn(async () => 1), zremrangebyscore: vi.fn(async () => 0) });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T23:30:00.000Z'));
    const { countCondition } = await import('../lib/redis.js');
    await countCondition('reminders.no_phone');
    expect(hincrby).toHaveBeenCalledWith('health:conditions:2026-11-05', 'reminders.no_phone', 1);
    hincrby.mockRejectedValueOnce(new Error('down'));
    await expect(countCondition('reminders.no_phone')).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
