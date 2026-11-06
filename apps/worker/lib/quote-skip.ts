/**
 * quote-tick's skip streak (keys.quoteDrafterSkip), read by the watchdog:
 * a run lock that stays taken for 15 ticks in a row, or a missing asset
 * manifest, is its own condition. The heartbeat only means a tick ran.
 *
 * - A `locked` or `no-assets` tick extends the streak (same reason) or starts one.
 * - A tick that ran clears a `locked` streak; a `no-assets` one only once a
 *   draft went through or the manifest is back (an idle tick never loads it).
 * - Mode off clears it: nothing is expected to draft.
 *
 * Never throws: observability must not fail the tick.
 */
import type { QuoteDrafterSkip } from '@aac/watchdog';
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';

const log = createLogger('worker-quote-skip');

export interface SkipRedis {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: QuoteDrafterSkip): Promise<unknown>;
  del(key: string): Promise<number>;
  hget<T>(key: string, field: string): Promise<T | null>;
}

export interface TickOutcome {
  skipped?: 'off' | 'locked' | 'no-assets';
  drafted: number;
}

export async function trackQuoteTickSkip(redis: SkipRedis, tick: TickOutcome, now = new Date()): Promise<void> {
  try {
    if (tick.skipped === 'off') {
      await redis.del(keys.quoteDrafterSkip);
      return;
    }
    const prev = await redis.get<QuoteDrafterSkip>(keys.quoteDrafterSkip);
    const at = now.toISOString();
    if (tick.skipped === 'locked' || tick.skipped === 'no-assets') {
      const next: QuoteDrafterSkip =
        prev?.reason === tick.skipped
          ? { ...prev, at, ticks: prev.ticks + 1 }
          : { reason: tick.skipped, since: at, at, ticks: 1 };
      await redis.set(keys.quoteDrafterSkip, next);
      return;
    }
    if (!prev) return;
    if (prev.reason === 'no-assets' && tick.drafted === 0) {
      const ruleset = await redis.hget<string>(keys.quoteDrafterAssets, 'ruleset');
      if (!ruleset) return;
    }
    await redis.del(keys.quoteDrafterSkip);
  } catch (err) {
    log.warn('quote-tick skip streak not recorded', { error: (err as Error).message });
  }
}
