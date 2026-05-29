import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Upstash Redis client BEFORE importing the module under test.
const { redisMock } = vi.hoisted(() => {
  return {
    redisMock: {
      set: vi.fn(),
      lpush: vi.fn(),
      ltrim: vi.fn(),
      get: vi.fn(),
      lrange: vi.fn(),
    },
  };
});

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => redisMock),
}));

import {
  markAgentQuoEventProcessed,
  appendAgentAuditEntry,
} from '../lib/redis.js';
import { resetEnvCache } from '../lib/env.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue('OK');
  redisMock.lpush.mockResolvedValue(1);
  redisMock.ltrim.mockResolvedValue('OK');

  process.env.PIPEDRIVE_API_KEY = 'pd';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'aac';
  process.env.PIPEDRIVE_SYSTEM_USER_ID = '1';
  process.env.QUO_API_KEY = 'quo';
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+18287724836';
  process.env.UPSTASH_REDIS_REST_URL = 'https://r';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe('markAgentQuoEventProcessed', () => {
  it('returns true when SET NX succeeds (new event)', async () => {
    redisMock.set.mockResolvedValueOnce('OK');
    const isNew = await markAgentQuoEventProcessed('evt_1');
    expect(isNew).toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      'dedupe:quo-agent:evt_1',
      'processed',
      { nx: true, ex: 86_400 }
    );
  });

  it('returns false when SET NX is rejected (duplicate)', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    const isNew = await markAgentQuoEventProcessed('evt_1');
    expect(isNew).toBe(false);
  });

  it('uses a separate dedup namespace from middleware (`quo-agent`, not `quo`)', async () => {
    await markAgentQuoEventProcessed('evt_xyz');
    const key = redisMock.set.mock.calls[0][0];
    expect(key).toBe('dedupe:quo-agent:evt_xyz');
    expect(key).not.toContain('dedupe:quo:');
  });
});

describe('appendAgentAuditEntry', () => {
  it('LPUSHes a JSON entry then LTRIMs to bound the list at 1000', async () => {
    await appendAgentAuditEntry({
      timestamp: '2026-05-28T18:00:00Z',
      caller: '+18287724836',
      role: 'owner',
      inboundText: 'check Davis deal',
      decision: 'ack',
      replyText: 'Got it',
      eventId: 'evt_1',
    });
    expect(redisMock.lpush).toHaveBeenCalledOnce();
    expect(redisMock.lpush.mock.calls[0][0]).toBe('agent:audit:stream');

    const stored = JSON.parse(redisMock.lpush.mock.calls[0][1]);
    expect(stored.caller).toBe('+18287724836');
    expect(stored.role).toBe('owner');
    expect(stored.decision).toBe('ack');
    expect(stored.inboundText).toBe('check Davis deal');
    expect(stored.replyText).toBe('Got it');
    expect(stored.eventId).toBe('evt_1');

    expect(redisMock.ltrim).toHaveBeenCalledWith('agent:audit:stream', 0, 999);
  });

  it('truncates very long inboundText and replyText to 500 chars + ellipsis', async () => {
    const big = 'x'.repeat(1000);
    await appendAgentAuditEntry({
      timestamp: '2026-05-28T18:00:00Z',
      caller: 'unknown',
      role: 'unknown',
      inboundText: big,
      decision: 'unknown_caller',
      replyText: big,
      eventId: 'evt_big',
    });
    const stored = JSON.parse(redisMock.lpush.mock.calls[0][1]);
    expect(stored.inboundText.endsWith('...')).toBe(true);
    expect(stored.inboundText.length).toBeLessThanOrEqual(503);
    expect(stored.replyText.endsWith('...')).toBe(true);
    expect(stored.replyText.length).toBeLessThanOrEqual(503);
  });

  it('omits replyText when not provided', async () => {
    await appendAgentAuditEntry({
      timestamp: '2026-05-28T18:00:00Z',
      caller: '+18287724836',
      role: 'owner',
      inboundText: 'hi',
      decision: 'ignore',
      eventId: 'evt_2',
    });
    const stored = JSON.parse(redisMock.lpush.mock.calls[0][1]);
    expect(stored.replyText).toBeUndefined();
  });
});
