/**
 * Who watches the watchdog (docs/projects/middleware-observability.md,
 * Layer A). The worker's watchdog texts Matt when a pipe breaks; if the
 * worker itself dies, its heartbeat goes stale and this check, running in
 * a different Vercel project, sends one daytime text per outage.
 */
import { keys } from '@aac/shared-utils/redis';
import { EASTERN_TZ, easternMinuteOfDay } from '@aac/shared-utils/eastern';

const STALE_MIN = 30;
/** Daytime only (Eastern): a dead watchdog is not worth a 2am text. */
const DAY_START_H = 8;
const DAY_END_H = 21;

export interface WatchdogWatchDeps {
  redis: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  };
  sms(text: string): Promise<void>;
  now?: Date;
}

export async function checkWatchdogHeartbeat(deps: WatchdogWatchDeps): Promise<'ok' | 'never-ran' | 'night' | 'already-sent' | 'texted'> {
  const now = deps.now ?? new Date();
  const last = await deps.redis.get<string>(keys.heartbeat('watchdog'));
  if (!last) return 'never-ran'; // not deployed yet: nothing to miss
  if (now.getTime() - Date.parse(last) <= STALE_MIN * 60_000) return 'ok';
  const hour = Math.floor(easternMinuteOfDay(now) / 60);
  if (hour < DAY_START_H || hour >= DAY_END_H) return 'night';
  // One text per outage: keyed by the last heartbeat it stopped at.
  const claimed = await deps.redis.set(keys.dedupe('watchdog-offline', last), 'sent', { nx: true, ex: 7 * 86_400 });
  if (claimed !== 'OK') return 'already-sent';
  const since = new Date(last).toLocaleString('en-US', { timeZone: EASTERN_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  await deps.sms(
    `⚠️ The pipe watchdog stopped (last check ${since}). The drafts worker is probably down too, so outages won't be texted. Fix: check aac-worker-monorepo in Vercel (cron runs, function errors).`,
  );
  return 'texted';
}
