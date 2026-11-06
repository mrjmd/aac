/**
 * /api/health is the outside pinger's view: 200 only while Redis answers
 * and the watchdog beat in the last 15 minutes; 503 otherwise. No auth, no
 * details in the body either way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const r = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string | null>>(),
}));
vi.mock('@upstash/redis', () => ({ Redis: vi.fn(() => ({ get: r.get })) }));

import { GET } from '../api/health.js';

const NOW = new Date('2026-11-05T16:20:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('/api/health', () => {
  it('200 {status: ok} while the watchdog beat recently, reading its heartbeat key', async () => {
    r.get.mockResolvedValue(ago(4));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(r.get).toHaveBeenCalledWith('health:watchdog:ts');
  });

  it('503 {status: down} once the watchdog heartbeat is 15 minutes old', async () => {
    r.get.mockResolvedValue(ago(15));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'down' });
  });

  it('503 when the watchdog never ran or the stamp is garbage', async () => {
    r.get.mockResolvedValue(null);
    expect((await GET()).status).toBe(503);
    r.get.mockResolvedValue('not a date');
    expect((await GET()).status).toBe(503);
  });

  it('503 when Redis errors, without leaking the error', async () => {
    r.get.mockRejectedValue(new Error('ECONNREFUSED upstash.example'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('ECONNREFUSED');
  });
});
