#!/usr/bin/env npx tsx
/** Set/inspect the quote-drafter mode override + queue state.
 *  Usage: npx tsx tools/src/scratch/quote-mode.ts [off|shadow|live|clear|status]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'off' || cmd === 'shadow' || cmd === 'live') {
    await redis.set(keys.quoteDrafterMode, cmd);
    console.log(`override set: ${cmd}`);
  } else if (cmd === 'clear') {
    await redis.del(keys.quoteDrafterMode);
    console.log('override cleared (env default applies)');
  }
  const [mode, qlen, due, pending, hb] = await Promise.all([
    redis.get(keys.quoteDrafterMode),
    redis.llen(keys.quoteTriggerQueue),
    redis.zrange<string[]>(keys.quoteTriggerDue, 0, -1, { withScores: true } as never),
    redis.hgetall(keys.quoteTriggerPending),
    redis.get(keys.heartbeat('quote-drafter')),
  ]);
  console.log({
    modeOverride: mode ?? '(none — env default)',
    queueLen: qlen,
    due,
    pendingPhones: pending ? Object.keys(pending) : [],
    heartbeat: hb,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
