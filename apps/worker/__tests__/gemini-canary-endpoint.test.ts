import { describe, it, expect, vi, beforeEach } from 'vitest';

const canary = vi.hoisted(() => vi.fn());
vi.mock('@aac/watchdog', () => ({ runGeminiCanary: canary }));
const hs = vi.hoisted(() => ({ client: { set: vi.fn(async () => 'OK'), lpush: vi.fn(async () => 1), ltrim: vi.fn(async () => 'OK') } }));
vi.mock('@upstash/redis', () => ({ Redis: vi.fn(() => hs.client) }));

import { GET as geminiCanary } from '../api/gemini-canary.js';

const req = (headers: Record<string, string> = {}) => new Request('https://worker.test/api/gemini-canary', { headers });
const cron = { authorization: 'Bearer cron-secret' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.GEMINI_API_KEY = 'gk';
});

describe('/api/gemini-canary', () => {
  it('rejects a request without the cron bearer or worker secret', async () => {
    expect((await geminiCanary(req())).status).toBe(401);
    expect(canary).not.toHaveBeenCalled();
  });

  it('runs the canary with a Gemini client and stamps cron:gemini-canary:last-run', async () => {
    canary.mockResolvedValueOnce({ ok: true, detail: 'passed' });
    const res = await geminiCanary(req(cron));
    expect(await res.json()).toEqual({ status: 'ok', canary: 'passed', detail: 'passed' });
    expect(canary.mock.calls[0][0].gemini).not.toBeNull();
    expect(hs.client.set).toHaveBeenCalledWith('cron:gemini-canary:last-run', expect.any(String));
  });

  it('a failed canary answers 200 (counted, not a health error) and runs with no client when the key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    canary.mockResolvedValueOnce({ ok: false, detail: 'GEMINI_API_KEY not set' });
    const res = await geminiCanary(req(cron));
    expect(res.status).toBe(200);
    expect(canary.mock.calls[0][0].gemini).toBeNull();
    expect(hs.client.lpush).not.toHaveBeenCalled();
  });
});
