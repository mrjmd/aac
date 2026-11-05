import { keys } from '@aac/shared-utils/redis';
import { DAILY_CRONS, evaluate, fmt, HEARTBEATS, INTERVAL_CRONS, type Condition, type Signals } from './checks.js';

const HOUR = 3_600_000;
/** Still down after this long since the last text: say so again. */
export const REMIND_AFTER_H = 6;
/** A condition must be seen down on this many consecutive ticks before the first text (one blip never pages). */
export const CONFIRM_TICKS = 2;

export interface OpenCondition {
  since: string;
  firstSeenAt: string;
  ticks: number;
  alertedAt?: string;
}

/** The Upstash calls the watchdog uses. Structural, so the worker passes its client. */
export interface WatchdogRedis {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<unknown>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
}

export interface WatchdogDeps {
  redis: WatchdogRedis;
  /** Newest lastActivityAt across the business line's recently active conversations. */
  quoNewestActivity(since: Date): Promise<string | null>;
  middlewareHealth(): Promise<{ ok: boolean; detail: string }>;
  /** Text Matt (agent line → his cell). */
  sms(text: string): Promise<void>;
  now?: () => Date;
}

export interface TickResult {
  down: string[];
  texted: string[];
  recovered: string[];
}

export async function gatherSignals(deps: WatchdogDeps, now: Date): Promise<Signals> {
  const { redis } = deps;
  const cronJobs = [...DAILY_CRONS.map((c) => c.job), ...INTERVAL_CRONS.map((c) => c.job)];
  const [quoNewest, quoProcessed, cronVals, beatVals, health] = await Promise.all([
    deps.quoNewestActivity(new Date(now.getTime() - 6 * HOUR)).then(
      (v) => ({ v }),
      (err: Error) => ({ error: err.message }),
    ),
    redis.get<string>(keys.webhookLast('quo')),
    Promise.all(cronJobs.map((j) => redis.get<string>(keys.cronLastRun(j)))),
    Promise.all(HEARTBEATS.map((h) => redis.get<string>(keys.heartbeat(h.name)))),
    deps.middlewareHealth().catch((err: Error) => ({ ok: false, detail: err.message })),
  ]);
  return {
    now,
    quo: 'error' in quoNewest ? { error: quoNewest.error } : { newestActivityAt: quoNewest.v, lastProcessedAt: quoProcessed },
    crons: Object.fromEntries(cronJobs.map((j, i) => [j, cronVals[i]])),
    heartbeats: Object.fromEntries(HEARTBEATS.map((h, i) => [h.name, beatVals[i]])),
    middlewareHealth: health,
  };
}

function downText(c: Condition, reminder: boolean): string {
  const since = c.since ? ` since ${fmt(c.since)}` : '';
  return `⚠️ ${reminder ? 'STILL DOWN: ' : ''}${c.title}${since}. ${c.impact} Fix: ${c.fix}`;
}

/**
 * One watchdog tick. Texts on a new outage (after CONFIRM_TICKS), every
 * REMIND_AFTER_H while it lasts, and once when it clears. Nothing else.
 */
export async function runWatchdogTick(deps: WatchdogDeps): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const conditions = evaluate(await gatherSignals(deps, now));
  const open = (await deps.redis.hgetall<Record<string, OpenCondition>>(keys.watchdogState)) ?? {};
  const result: TickResult = { down: [], texted: [], recovered: [] };
  const writes: Record<string, OpenCondition> = {};
  const cleared: string[] = [];

  for (const c of conditions) {
    const prev = open[c.id];
    if (!c.down) {
      if (prev) {
        cleared.push(c.id);
        // Only announce recovery for outages Matt was told about.
        if (prev.alertedAt) {
          await deps.sms(`✅ Recovered: ${c.title.replace(/ (DOWN|stopped|missed its run|failing)$/, '')} is back (was down since ${fmt(prev.since)}).`);
          result.recovered.push(c.id);
        }
      }
      continue;
    }
    result.down.push(c.id);
    const next: OpenCondition = prev
      ? { ...prev, ticks: prev.ticks + 1 }
      : { since: c.since ?? nowIso, firstSeenAt: nowIso, ticks: 1 };
    const due = next.ticks >= CONFIRM_TICKS && (!next.alertedAt || now.getTime() - Date.parse(next.alertedAt) >= REMIND_AFTER_H * HOUR);
    if (due) {
      await deps.sms(downText(c, !!next.alertedAt));
      next.alertedAt = nowIso;
      result.texted.push(c.id);
    }
    writes[c.id] = next;
  }

  if (Object.keys(writes).length) await deps.redis.hset(keys.watchdogState, writes);
  if (cleared.length) await deps.redis.hdel(keys.watchdogState, ...cleared);
  await deps.redis.set(keys.heartbeat('watchdog'), nowIso);
  return result;
}
