/**
 * Fast-cadence drains, run every ~60s (worker cron tick + laptop ticks).
 * Cheap when idle: one LPOP + one ZRANGEBYSCORE against Redis.
 */
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { createLogger } from '@aac/shared-utils/logger';
import type { DraftDeps, DraftRecord } from './types.js';
import { processFollowupById } from './followup.js';
import { processIntakePhone } from './intake.js';

const log = createLogger('message-drafts-tick');

/** Tries per queued estimate before a failing one is dropped (the 36h sweep still covers it). */
export const FOLLOWUP_QUEUE_MAX_ATTEMPTS = 3;

/** Queue element: the middleware LPUSHes `{ estimateId, at }`; a requeue adds `attempts`. */
interface FollowupQueueEntry {
  estimateId: string;
  at?: string;
  attempts: number;
}

function parseQueueEntry(q: unknown): FollowupQueueEntry | null {
  try {
    const o = (typeof q === 'string' ? JSON.parse(q) : q) as
      | { estimateId?: unknown; at?: unknown; attempts?: unknown }
      | null;
    const estimateId = String(o?.estimateId ?? '');
    if (!estimateId) return null;
    return {
      estimateId,
      ...(typeof o?.at === 'string' ? { at: o.at } : {}),
      attempts: typeof o?.attempts === 'number' ? o.attempts : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Drain the webhook-fed estimate queue (quote email just went out).
 *
 * The LPOP takes entries off the queue before they're processed, so a
 * throw must not lose the rest: the failing entry (attempts + 1) and every
 * entry after it go back on the head of the queue in popped order, then
 * the error is rethrown so the caller still records the failure. An entry
 * that has failed FOLLOWUP_QUEUE_MAX_ATTEMPTS times is dropped with an
 * error log instead (no poison-pill loop; the sweep is the backstop). An
 * invocation killed mid-loop (timeout) still loses its popped entries;
 * the sweep covers those too.
 */
export async function drainFollowupQueue(deps: DraftDeps, redis: Redis): Promise<DraftRecord[]> {
  const raw = (await redis.lpop<unknown>(keys.messageDraftQueue, 100)) ?? [];
  const seen = new Set<string>();
  const entries: FollowupQueueEntry[] = [];
  for (const q of Array.isArray(raw) ? raw : [raw]) {
    const entry = parseQueueEntry(q);
    if (!entry || seen.has(entry.estimateId)) continue;
    seen.add(entry.estimateId);
    entries.push(entry);
  }
  const records: DraftRecord[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const record = await processFollowupById(deps, entry.estimateId);
      if (record) records.push(record);
    } catch (err) {
      const attempts = entry.attempts + 1;
      const rest = entries.slice(i + 1);
      if (attempts >= FOLLOWUP_QUEUE_MAX_ATTEMPTS) {
        log.error('follow-up queue entry dropped after repeated failures', err, {
          estimateId: entry.estimateId,
          attempts,
        });
      } else {
        rest.unshift({ ...entry, attempts });
      }
      // LPUSH leaves its last argument at the head: push in reverse so the
      // next LPOP sees the same order this one did.
      if (rest.length) {
        await redis.lpush(keys.messageDraftQueue, ...rest.reverse().map((e) => JSON.stringify(e)));
      }
      throw err;
    }
  }
  return records;
}

/**
 * Pop intake phones whose 10-min preemption window has elapsed (ZADDed by
 * the Quo webhook on first inbound). `retry-later` outcomes are re-armed
 * a couple minutes out instead of dropped.
 */
export async function drainIntakeDue(deps: DraftDeps, redis: Redis): Promise<DraftRecord[]> {
  const now = deps.now?.() ?? Date.now();
  const due = await redis.zrange<string[]>(keys.messageDraftIntakeDue, 0, now, { byScore: true });
  const records: DraftRecord[] = [];
  for (const phone of due) {
    await redis.zrem(keys.messageDraftIntakeDue, phone);
    const outcome = await processIntakePhone(deps, phone);
    if (outcome.kind === 'drafted') records.push(outcome.record);
    else if (outcome.kind === 'retry-later') {
      await redis.zadd(keys.messageDraftIntakeDue, { score: now + 2 * 60_000, member: phone });
    }
  }
  return records;
}

/**
 * The inbound router owns first touch (`inbound-router:live` has intake):
 * clear the due intake phones without drafting, so the ZSET the webhook
 * still arms doesn't grow. Returns how many were dropped.
 */
export async function dropIntakeDue(deps: DraftDeps, redis: Redis): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const due = await redis.zrange<string[]>(keys.messageDraftIntakeDue, 0, now, { byScore: true });
  if (due.length) await redis.zrem(keys.messageDraftIntakeDue, ...due);
  return due.length;
}
