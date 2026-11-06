/**
 * Worker silent-skip counts (System health page): the routes and the deps
 * they hand the packages count through lib/conditions.ts →
 * @aac/shared-utils/health countCondition on the health Redis client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hs = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, number>>();
  const client = {
    set: vi.fn(async () => 'OK'),
    lpush: vi.fn(async () => 1),
    ltrim: vi.fn(async () => 'OK'),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      const h = hashes.get(key) ?? new Map<string, number>();
      h.set(field, (h.get(field) ?? 0) + by);
      hashes.set(key, h);
      return h.get(field)!;
    }),
    hset: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    zadd: vi.fn(async () => 1),
    zremrangebyscore: vi.fn(async () => 0),
  };
  return { hashes, client };
});
vi.mock('@upstash/redis', () => ({ Redis: vi.fn(() => hs.client) }));

const router = vi.hoisted(() => ({
  runInboundTick: vi.fn(),
}));
vi.mock('@aac/inbound-router', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...router }));

const quote = vi.hoisted(() => ({
  pollQuoteEmails: vi.fn(),
  resolveMode: vi.fn(async () => 'live'),
}));
vi.mock('@aac/quote-drafter', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...quote }));
vi.mock('../lib/quote-deps.js', () => ({ getQuoteDeps: () => ({ redis: {} }), envMode: () => 'live' }));

import { GET as inboundTick } from '../api/inbound-tick.js';
import { GET as quoteEmailTick } from '../api/quote-email-tick.js';
import { countCondition } from '../lib/conditions.js';

const TODAY_KEY = 'health:conditions:2026-11-05';
const cron = (path: string) => new Request(`https://worker.test${path}`, { headers: { authorization: 'Bearer cron-secret' } });

beforeEach(() => {
  vi.clearAllMocks();
  hs.hashes.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.QUO_API_KEY = 'k';
  process.env.QUO_PHONE_NUMBER = '+16175550000';
  process.env.QUICKBOOKS_CLIENT_ID = 'x';
  process.env.QUICKBOOKS_CLIENT_SECRET = 'x';
  process.env.QUICKBOOKS_REALM_ID = 'x';
  process.env.QUICKBOOKS_REDIRECT_URI = 'x';
  process.env.GEMINI_API_KEY = 'x';
  process.env.GOOGLE_CLIENT_ID = 'g';
  process.env.GOOGLE_CLIENT_SECRET = 'g';
  process.env.GOOGLE_REFRESH_TOKEN = 'g';
});
afterEach(() => vi.useRealTimers());

describe('worker condition counts', () => {
  it('countCondition writes today\'s Eastern hash', async () => {
    await countCondition('intake.generation_failed');
    expect(hs.hashes.get(TODAY_KEY)?.get('intake.generation_failed')).toBe(1);
  });

  it('inbound-tick counts router.read_failed once per failed burst', async () => {
    router.runInboundTick.mockResolvedValueOnce({
      mode: 'shadow',
      due: 3,
      entries: [
        { at: 'x', phone: '+15085550001', outcome: 'failed', detail: 'gemini 404' },
        { at: 'x', phone: '+15085550002', outcome: 'failed', detail: 'gemini 404' },
        { at: 'x', phone: '+15085550003', outcome: 'decided', routes: [] },
      ],
    });
    expect((await inboundTick(cron('/api/inbound-tick'))).status).toBe(200);
    expect(hs.hashes.get(TODAY_KEY)?.get('router.read_failed')).toBe(2);
    // Rolling window for the watchdog's Gemini-degraded check.
    expect(hs.client.zadd).toHaveBeenCalledWith('health:conditions:recent:router.read_failed', expect.anything(), expect.anything());
  });

  it('inbound-tick counts nothing when every burst was read', async () => {
    router.runInboundTick.mockResolvedValueOnce({ mode: 'shadow', due: 1, entries: [{ at: 'x', phone: '+1', outcome: 'decided' }] });
    await inboundTick(cron('/api/inbound-tick'));
    expect(hs.client.hincrby).not.toHaveBeenCalled();
  });

  it('quote-email-tick counts quote-email.no_scope when the token lacks gmail.readonly', async () => {
    quote.pollQuoteEmails.mockRejectedValueOnce(new Error('Gmail API 403: insufficient authentication scopes'));
    const res = await quoteEmailTick(cron('/api/quote-email-tick'));
    expect(await res.json()).toMatchObject({ status: 'ok', skipped: 'no-gmail-scope' });
    expect(hs.hashes.get(TODAY_KEY)?.get('quote-email.no_scope')).toBe(1);
  });

  it('the drafts deps and stale-quote deps carry countCondition into the packages', async () => {
    const { getWorkerDeps } = await import('../lib/deps.js');
    await getWorkerDeps().deps.countCondition?.('followup.skeleton_fallback');
    const { getStaleQuoteDeps } = await import('../lib/stale-quotes-deps.js');
    await getStaleQuoteDeps()?.countCondition?.('stale-quotes.note_failed');
    expect(hs.hashes.get(TODAY_KEY)?.get('followup.skeleton_fallback')).toBe(1);
    expect(hs.hashes.get(TODAY_KEY)?.get('stale-quotes.note_failed')).toBe(1);
  });
});
