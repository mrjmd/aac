#!/usr/bin/env npx tsx
/**
 * Bridge: publish the laptop triage run's findings as item candidates so the
 * command center's Today page has real data before the detectors move to the
 * cloud worker (docs/plans/command-center/README.md §9, Phase 1 step 3).
 * Retire once the worker writes keys.itemCandidates itself.
 *
 *   npx tsx tools/src/items/push-triage.ts [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { fromTriageFinding, ItemStore, type TriageFinding } from '@aac/items';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  loadEnv();
  const file = path.resolve(process.cwd(), 'analysis/data/triage/findings.json');
  const { generatedAt, findings } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    generatedAt: string;
    findings: TriageFinding[];
  };
  const candidates = findings.map(fromTriageFinding);
  const byArea = candidates.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.area]: (acc[c.area] ?? 0) + 1 }), {});
  console.log(`${candidates.length} candidates from triage run ${generatedAt}`, byArea);
  if (process.argv.includes('--dry-run')) return;

  const store = new ItemStore(
    new Redis({ url: requireEnv('UPSTASH_REDIS_REST_URL'), token: requireEnv('UPSTASH_REDIS_REST_TOKEN') }),
  );
  await store.putCandidates({ at: generatedAt, source: 'triage-laptop', candidates });
  console.log('Published to keys.itemCandidates');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
