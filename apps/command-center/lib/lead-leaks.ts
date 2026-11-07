import type { LeadLeakSnapshot } from "@aac/lead-leaks";
import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

/** The worker's nightly snapshot and Matt's handled marks (Redis only, no live fetch). */
export async function loadLeadLeaks(): Promise<{ snapshot: LeadLeakSnapshot | null; handled: Record<string, string> }> {
  const redis = getRedis();
  const [snapshot, handled] = await Promise.all([
    redis.get<LeadLeakSnapshot>(keys.leadLeaks).catch(() => null),
    redis.hgetall<Record<string, string>>(keys.leadLeakHandled).catch(() => null),
  ]);
  return { snapshot, handled: handled ?? {} };
}

/** Mark one lead handled as of its thread's lastActivityAt (it comes back when the thread moves); null clears the mark. */
export async function setLeadHandled(phone: string, lastActivityAt: string | null): Promise<void> {
  const redis = getRedis();
  if (lastActivityAt) await redis.hset(keys.leadLeakHandled, { [phone]: lastActivityAt });
  else await redis.hdel(keys.leadLeakHandled, phone);
}
