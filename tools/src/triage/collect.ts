#!/usr/bin/env npx tsx
/**
 * Triage dashboard — data collection (thin CLI over @aac/triage collect).
 *
 * Writes analysis/data/triage/snapshot.json. Call transcripts and voicemails
 * are cached in Redis (RedisTriageStore), shared with the worker's run.
 * Run from repo root. Creds from .env.diagnostic. See
 * docs/projects/triage-dashboard.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { collect, RedisTriageStore } from '@aac/triage';
import { calendarFromEnv, gmailFromEnv, loadEnv, quickBooksFromEnv, quoFromEnv, redisFromEnv, requireEnv } from '../lib/env';

export type { CustomerSnapshot, EmailThreadSnapshot, Snapshot, ThreadSnapshot } from '@aac/triage';

async function main(): Promise<void> {
  loadEnv();
  const outDir = path.resolve(process.cwd(), 'analysis/data/triage');
  fs.mkdirSync(outDir, { recursive: true });
  const redis = redisFromEnv();

  const snapshot = await collect({
    redis,
    qb: quickBooksFromEnv(redis),
    quo: quoFromEnv(),
    calendar: calendarFromEnv(),
    gmail: gmailFromEnv,
    store: new RedisTriageStore(redis),
    quoPhoneNumber: requireEnv('QUO_PHONE_NUMBER'),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  });

  const outPath = path.join(outDir, 'snapshot.json');
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 1));
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)}KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
