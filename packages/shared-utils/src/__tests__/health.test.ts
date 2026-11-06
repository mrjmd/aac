import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HEALTH_ERRORS_CAP,
  logHealthError,
  trackCronRun,
  trackWebhookProcessed,
  writeHeartbeat,
  type HealthRedis,
} from '../health.js';

/** In-memory stand-in recording every write, with list semantics for LPUSH/LTRIM. */
function fakeRedis() {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  const redis = {
    set: vi.fn(async (key: string, value: string, opts?: { ex: number }) => {
      strings.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const n = Number(strings.get(key) ?? 0) + 1;
      strings.set(key, String(n));
      return n;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
    lpush: vi.fn(async (key: string, ...elements: string[]) => {
      const list = lists.get(key) ?? [];
      list.unshift(...elements.reverse());
      lists.set(key, list);
      return list.length;
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1));
      return 'OK';
    }),
  } satisfies HealthRedis;
  return { redis, strings, lists, ttls };
}

const NOW = new Date('2026-11-05T23:30:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('trackWebhookProcessed', () => {
  it('increments webhooks:{source}:{UTC day}:count (48h TTL) and stamps webhooks:{source}:last', async () => {
    const f = fakeRedis();
    await trackWebhookProcessed(f.redis, 'quo');
    await trackWebhookProcessed(f.redis, 'quo');
    expect(f.strings.get('webhooks:quo:2026-11-05:count')).toBe('2');
    expect(f.ttls.get('webhooks:quo:2026-11-05:count')).toBe(172_800);
    // The watchdog and /api/health read this as an ISO string.
    expect(f.strings.get('webhooks:quo:last')).toBe(NOW.toISOString());
  });
});

describe('logHealthError', () => {
  it('LPUSHes a JSON {source, message, details, commitSha, timestamp} onto health:errors', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc123');
    const f = fakeRedis();
    await logHealthError(f.redis, 'quo', 'pipedrive 503', { eventId: 'e1' });
    const list = f.lists.get('health:errors')!;
    expect(list).toHaveLength(1);
    // Readers: middleware /api/health (timestamp/source/message/details),
    // agent error-surface (timestamp/source/message required, commitSha dedup).
    expect(JSON.parse(list[0])).toEqual({
      source: 'quo',
      message: 'pipedrive 503',
      details: { eventId: 'e1' },
      commitSha: 'abc123',
      timestamp: NOW.toISOString(),
    });
  });

  it("stamps commitSha 'local' outside Vercel and omits undefined details", async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    const f = fakeRedis();
    await logHealthError(f.redis, 'cron:job-reminders', 'boom');
    const parsed = JSON.parse(f.lists.get('health:errors')![0]) as Record<string, unknown>;
    expect(parsed.commitSha).toBe('local');
    expect('details' in parsed).toBe(false);
  });

  it('keeps the newest 100 entries, newest first', async () => {
    expect(HEALTH_ERRORS_CAP).toBe(100);
    const f = fakeRedis();
    for (let i = 0; i < 105; i++) await logHealthError(f.redis, 's', `m${i}`);
    const list = f.lists.get('health:errors')!;
    expect(list).toHaveLength(100);
    expect(JSON.parse(list[0]).message).toBe('m104');
    expect(f.redis.ltrim).toHaveBeenLastCalledWith('health:errors', 0, 99);
  });
});

describe('writeHeartbeat', () => {
  it('stamps health:{app}:ts with an ISO time (watchdog, triage, quote-trigger mode read it)', async () => {
    const f = fakeRedis();
    await writeHeartbeat(f.redis, 'agent');
    expect(f.strings.get('health:agent:ts')).toBe(NOW.toISOString());
  });
});

describe('trackCronRun', () => {
  it('stamps cron:{job}:last-run (ISO, no TTL) and cron:{job}:{UTC day}:result (JSON, 30d TTL)', async () => {
    const f = fakeRedis();
    await trackCronRun(f.redis, 'job-reminders', { sent: 3, skipped: 1, errors: 0 });
    // The watchdog reads cron:{job}:last-run as an ISO string.
    expect(f.strings.get('cron:job-reminders:last-run')).toBe(NOW.toISOString());
    expect(f.ttls.has('cron:job-reminders:last-run')).toBe(false);
    expect(JSON.parse(f.strings.get('cron:job-reminders:2026-11-05:result')!)).toEqual({ sent: 3, skipped: 1, errors: 0 });
    expect(f.ttls.get('cron:job-reminders:2026-11-05:result')).toBe(30 * 86_400);
  });
});

describe('never throws', () => {
  const down = () => Promise.reject(new Error('ECONNREFUSED redis'));
  const deadRedis: HealthRedis = { set: down, incr: down, expire: down, lpush: down, ltrim: down };

  it('swallows a Redis outage in every health write and logs it', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(trackWebhookProcessed(deadRedis, 'quo')).resolves.toBeUndefined();
      await expect(logHealthError(deadRedis, 'quo', 'pipedrive 503', { eventId: 'e1' })).resolves.toBeUndefined();
      await expect(writeHeartbeat(deadRedis, 'middleware')).resolves.toBeUndefined();
      await expect(trackCronRun(deadRedis, 'job-reminders', { sent: 0, skipped: 0, errors: 1 })).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledTimes(4);
      // The health error that couldn't be stored still reaches the log.
      const logged = JSON.parse(errSpy.mock.calls[1][0] as string) as Record<string, unknown>;
      expect(logged).toMatchObject({ module: 'health', source: 'quo', healthMessage: 'pipedrive 503', error: 'ECONNREFUSED redis' });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('swallows a synchronous throw from the client too', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = (): never => {
      throw new Error('client not configured');
    };
    try {
      await expect(writeHeartbeat({ ...deadRedis, set: boom }, 'agent')).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
