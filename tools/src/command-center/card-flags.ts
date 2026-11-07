/**
 * Matt's "this looks wrong" flags from the command center (cc:card-flags).
 * Read the open ones at the start of every session and fix them first.
 *
 *   tsx tools/src/command-center/card-flags.ts              open flags, with what the card showed
 *   tsx tools/src/command-center/card-flags.ts fix <id> "<what was wrong, what changed>"
 */
import { keys } from '@aac/shared-utils/redis';
import { loadEnv, redisFromEnv } from '../lib/env';

interface CardFlag {
  id: string;
  at: string;
  page: string;
  card: string;
  note: string;
  text: string;
  fixedAt?: string;
  fix?: string;
}

loadEnv();
const redis = redisFromEnv();
const [, , cmd, id, ...rest] = process.argv;

if (cmd === 'fix') {
  const flag = id ? await redis.hget<CardFlag>(keys.ccCardFlags, id) : null;
  if (!flag) throw new Error(`No flag ${id}`);
  await redis.hset(keys.ccCardFlags, { [flag.id]: { ...flag, fixedAt: new Date().toISOString(), fix: rest.join(' ') } });
  console.log(`Fixed: ${flag.card} (${flag.page})`);
} else {
  const all = Object.values((await redis.hgetall<Record<string, CardFlag>>(keys.ccCardFlags)) ?? {});
  const open = all.filter((f) => !f.fixedAt).sort((a, b) => a.at.localeCompare(b.at));
  if (!open.length) console.log('No open flags.');
  for (const f of open) {
    console.log(`\n=== ${f.id}  ${f.at}  ${f.page}  "${f.card}"`);
    console.log(`Note: ${f.note}`);
    console.log(`Card showed:\n${f.text.split('\n').map((l) => `  ${l}`).join('\n')}`);
  }
}
