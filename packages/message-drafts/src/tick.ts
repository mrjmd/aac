/**
 * Fast-cadence drains, run every ~60s (worker cron tick + laptop ticks).
 * Cheap when idle: one LPOP + one ZRANGEBYSCORE against Redis.
 */
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import type { DraftDeps, DraftRecord } from './types.js';
import { processFollowupById } from './followup.js';
import { processIntakePhone } from './intake.js';

/** Drain the webhook-fed estimate queue (quote email just went out). */
export async function drainFollowupQueue(deps: DraftDeps, redis: Redis): Promise<DraftRecord[]> {
  const raw = (await redis.lpop<unknown>(keys.messageDraftQueue, 100)) ?? [];
  const ids = [
    ...new Set(
      (Array.isArray(raw) ? raw : [raw])
        .map((q) => {
          try {
            const o = typeof q === 'string' ? JSON.parse(q) : q;
            return String((o as { estimateId?: unknown })?.estimateId ?? '');
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    ),
  ];
  const records: DraftRecord[] = [];
  for (const id of ids) {
    const record = await processFollowupById(deps, id);
    if (record) records.push(record);
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
