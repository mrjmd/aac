import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
};

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => mockRedis),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: vi.fn(() => ({
    redis: { url: 'https://test', token: 'test' },
  })),
}));

import { enqueueQuoteTrigger } from '../lib/redis.js';

describe('enqueueQuoteTrigger', () => {
  beforeEach(() => {
    mockRedis.lpush.mockClear().mockResolvedValue(1);
    mockRedis.ltrim.mockClear().mockResolvedValue('OK');
  });

  it('pushes the compact event onto the trigger queue and caps it', async () => {
    const event = {
      phone: '+16175551234',
      direction: 'incoming' as const,
      at: '2026-10-18T12:00:00.000Z',
      hasMedia: true,
      snippet: 'here are the photos of the crack',
    };
    await enqueueQuoteTrigger(event);

    expect(mockRedis.lpush).toHaveBeenCalledWith('quote-trigger:queue', JSON.stringify(event));
    expect(mockRedis.ltrim).toHaveBeenCalledWith('quote-trigger:queue', 0, 999);
  });

  it('carries the mike-debrief kind for T2 events', async () => {
    const event = {
      phone: '+18573126761',
      direction: 'incoming' as const,
      at: '2026-10-18T16:00:00.000Z',
      hasMedia: false,
      snippet: '',
      kind: 'mike-debrief' as const,
    };
    await enqueueQuoteTrigger(event);
    const pushed = JSON.parse(mockRedis.lpush.mock.calls[0][1] as string);
    expect(pushed.kind).toBe('mike-debrief');
  });

  it('never throws — webhook processing must not be affected', async () => {
    mockRedis.lpush.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      enqueueQuoteTrigger({
        phone: '+16175551234',
        direction: 'outgoing',
        at: '2026-10-18T12:00:00.000Z',
        hasMedia: false,
        snippet: "I'll get that quote over to you tonight",
      }),
    ).resolves.toBeUndefined();
  });
});
