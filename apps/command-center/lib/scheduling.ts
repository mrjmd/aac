/**
 * Read pending SchedulingDirectives from Redis.
 *
 * The middleware webhook handlers write directives via
 * `writePendingDirective` — blob stored at `scheduling:pending:{id}`, id
 * pushed onto `scheduling:pending:list` (capped at 500, newest first).
 *
 * This is the read side for the command-center scheduling view.
 */

import { getRedis } from "./redis";
import { keys } from "@aac/shared-utils/redis";
import type { SchedulingDirective } from "@aac/scheduling";

export interface PendingDirectivesResult {
  directives: SchedulingDirective[];
  totalIds: number;
  fetched: number;
  staleIds: string[];
}

/**
 * Read up to `limit` most-recent pending directives.
 * Returns the parsed blobs in list order (newest first).
 */
export async function fetchPendingDirectives(
  limit = 100,
): Promise<PendingDirectivesResult> {
  const redis = getRedis();
  const ids = await redis.lrange<string>(keys.schedulingPendingList, 0, limit - 1);

  if (ids.length === 0) {
    return { directives: [], totalIds: 0, fetched: 0, staleIds: [] };
  }

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(keys.schedulingPending(id));
  const results = await pipeline.exec<(SchedulingDirective | null)[]>();

  const directives: SchedulingDirective[] = [];
  const staleIds: string[] = [];
  results.forEach((d, i) => {
    if (d) directives.push(d);
    else staleIds.push(ids[i]);
  });

  return { directives, totalIds: ids.length, fetched: directives.length, staleIds };
}
