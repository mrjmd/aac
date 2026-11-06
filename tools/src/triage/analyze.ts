#!/usr/bin/env npx tsx
/**
 * Triage dashboard — gap detectors (thin CLI over @aac/triage analyze).
 *
 * Reads analysis/data/triage/snapshot.json, writes findings.json, then
 * publishes the run as command-center items (push-items.ts) unless
 * --no-push. Transcripts and dismissals come from Redis (RedisTriageStore).
 *
 * Detector catalog lives in docs/projects/triage-dashboard.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { technicianEmails } from '@aac/shared-utils/calendar';
import { analyze, RedisTriageStore, type Snapshot } from '@aac/triage';
import { pushItems } from './push-items.ts';
import { loadEnv, redisFromEnv } from '../lib/env';

export type { Finding, FindingsFile, Section } from '@aac/triage';

async function main(): Promise<void> {
  loadEnv();
  const dataDir = path.resolve(process.cwd(), 'analysis/data/triage');
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshot.json'), 'utf8')) as Snapshot;

  const out = await analyze(snapshot, {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    store: new RedisTriageStore(redisFromEnv()),
    quoPhoneNumber: process.env.QUO_PHONE_NUMBER ?? '',
    technicianEmails: technicianEmails(process.env.TECHNICIAN_EMAILS),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  });

  const outPath = path.join(dataDir, 'findings.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`Wrote ${outPath} — ${out.findings.length} findings (${out.stats.llmErrors ?? 0} LLM errors)`);

  // Best-effort: the command center reads these as items. A failed push
  // never fails the triage run (triage.html still renders).
  if (!process.argv.includes('--no-push')) {
    try {
      await pushItems(out);
    } catch (err) {
      console.error(`!! command-center item push failed (re-run tools/src/triage/push-items.ts): ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
