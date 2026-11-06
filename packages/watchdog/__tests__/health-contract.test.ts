/**
 * Reader contract: the watchdog reads what @aac/shared-utils/health writes
 * (Quo webhook last-processed, middleware cron last-runs, worker
 * heartbeats). Writes through the shared functions, reads through
 * gatherSignals, so a key or value-shape change on either side fails here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { trackCronRun, trackWebhookProcessed, writeHeartbeat, type HealthRedis } from '@aac/shared-utils/health';
import { gatherSignals, type WatchdogRedis } from '../src/index.js';

function store() {
  const strings = new Map<string, string>();
  const writer: HealthRedis = {
    set: async (key, value) => {
      strings.set(key, value);
      return 'OK';
    },
    incr: async (key) => {
      const n = Number(strings.get(key) ?? 0) + 1;
      strings.set(key, String(n));
      return n;
    },
    expire: async () => 1,
    lpush: async () => 1,
    ltrim: async () => 'OK',
  };
  const reader: WatchdogRedis = {
    get: async <T>(key: string) => (strings.has(key) ? (strings.get(key) as T) : null),
    set: async () => 'OK',
    hgetall: async () => null,
    hset: async () => 0,
    hdel: async () => 0,
  };
  return { writer, reader };
}

afterEach(() => vi.useRealTimers());

describe('watchdog reads the shared health writers', () => {
  it('sees Quo processing, cron last-runs and worker heartbeats at the time they were written', async () => {
    const at = new Date('2026-11-05T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const { writer, reader } = store();
    await trackWebhookProcessed(writer, 'quo');
    await trackCronRun(writer, 'job-reminders', { sent: 1, skipped: 0, errors: 0 });
    await trackCronRun(writer, 'qb-reconcile', { sent: 0, skipped: 4, errors: 0 });
    await writeHeartbeat(writer, 'worker');
    await writeHeartbeat(writer, 'quote-drafter');
    vi.useRealTimers();

    const signals = await gatherSignals(
      {
        redis: reader,
        quoNewestActivity: async () => null,
        middlewareHealth: async () => ({ ok: true, detail: '200' }),
        sms: async () => {},
      },
      new Date('2026-11-05T16:05:00Z'),
    );

    const iso = at.toISOString();
    expect(signals.quo).toEqual({ newestActivityAt: null, lastProcessedAt: iso });
    expect(signals.crons['job-reminders']).toBe(iso);
    expect(signals.crons['qb-reconcile']).toBe(iso);
    expect(signals.crons['invoice-create']).toBeNull();
    expect(signals.heartbeats).toEqual({ worker: iso, 'quote-drafter': iso });
  });
});
