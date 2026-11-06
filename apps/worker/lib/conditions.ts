/**
 * Silent-skip counts for the command center System health page, through
 * @aac/shared-utils/health countCondition on the worker's health Redis
 * client (lib/health.ts). Never throws; a no-op without the Upstash env.
 */
import * as health from '@aac/shared-utils/health';
import { healthRedis } from './health.js';

export async function countCondition(name: health.ConditionName, opts?: health.CountConditionOptions): Promise<void> {
  const redis = healthRedis();
  if (!redis) return;
  await health.countCondition(redis, name, opts);
}
