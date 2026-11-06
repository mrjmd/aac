#!/usr/bin/env npx tsx
/**
 * Bridge: publish a triage run as command-center item candidates, so the
 * command center shows what triage.html shows. analyze.ts calls this after
 * writing findings.json (skip with --no-push); run it by hand to re-push the
 * last run. Thin CLI over @aac/triage triageCandidates + publishTriageItems;
 * retire once the cloud worker writes keys.itemCandidates itself
 * (docs/plans/triage-to-worker.md).
 *
 *   npx tsx tools/src/triage/push-items.ts [--dry-run]
 *
 * The laptop passes the bot-draft edit labels (edit-labels.jsonl) and the
 * legacy shadow-log; the stale-quote lists come from @aac/stale-quotes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishTriageItems, triageCandidates, type FindingsFile } from '@aac/triage';
import { loadDraftLabels, loadLegacyBotLog, loadStaleQuoteLists } from './sections.ts';
import { loadEnv, redisFromEnv } from '../lib/env';

/** Publish to keys.itemCandidates. Needs UPSTASH_REDIS_REST_URL/TOKEN in env. */
export async function pushItems(data: FindingsFile, opts: { dryRun?: boolean } = {}): Promise<void> {
  const redis = redisFromEnv();
  const candidates = triageCandidates(data, await loadStaleQuoteLists(redis), {
    now: Date.now(),
    labels: loadDraftLabels(),
    legacyBotLog: loadLegacyBotLog(),
  });
  const byDetector = candidates.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.detector]: (acc[c.detector] ?? 0) + 1 }), {});
  console.log(`${candidates.length} item candidates from triage run ${data.generatedAt}`, byDetector);
  if (opts.dryRun) return;
  await publishTriageItems({ redis }, { at: data.generatedAt, source: 'triage-laptop', candidates });
  console.log('Published to keys.itemCandidates');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  const file = path.resolve(process.cwd(), 'analysis/data/triage/findings.json');
  pushItems(JSON.parse(fs.readFileSync(file, 'utf8')) as FindingsFile, { dryRun: process.argv.includes('--dry-run') }).catch(
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
