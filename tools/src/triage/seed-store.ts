#!/usr/bin/env npx tsx
/**
 * One-time seed of the triage store (Redis) from the laptop files:
 *   analysis/data/triage/transcripts/{callId}.json    → triage:transcript:{callId}
 *   analysis/data/triage/transcripts/vm-{callId}.json → triage:voicemail:{callId}
 *   analysis/data/triage/dismissals.json              → triage:dismissals
 *
 * Usage (repo root): npx tsx tools/src/triage/seed-store.ts [--dry-run]
 * --dry-run counts keys + bytes and writes nothing. Existing Redis entries
 * are overwritten with the file's content (same JSON either way).
 */

import fs from 'node:fs';
import path from 'node:path';
import { keys } from '@aac/shared-utils/redis';
import { RedisTriageStore, type CachedTranscript, type CachedVoicemail, type DismissalRule } from '@aac/triage';
import { loadEnv, redisFromEnv } from '../lib/env';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  loadEnv();
  const dataDir = path.resolve(process.cwd(), 'analysis/data/triage');
  const transcriptDir = path.join(dataDir, 'transcripts');
  const store = dryRun ? null : new RedisTriageStore(redisFromEnv());

  let transcripts = 0;
  let voicemails = 0;
  let bytes = 0;
  const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(transcriptDir, file), 'utf8');
    const value = JSON.parse(raw) as CachedTranscript | CachedVoicemail;
    const isVm = file.startsWith('vm-');
    const callId = file.replace(/^vm-/, '').replace(/\.json$/, '');
    const key = isVm ? keys.triageVoicemail(callId) : keys.triageTranscript(callId);
    bytes += Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (isVm) {
      voicemails++;
      if (store) await store.setVoicemail(callId, value as CachedVoicemail);
    } else {
      transcripts++;
      if (store) await store.setTranscript(callId, value as CachedTranscript);
    }
  }

  let dismissals = 0;
  const dismissalsPath = path.join(dataDir, 'dismissals.json');
  if (fs.existsSync(dismissalsPath)) {
    const rules = JSON.parse(fs.readFileSync(dismissalsPath, 'utf8')) as DismissalRule[];
    dismissals = rules.length;
    bytes += Buffer.byteLength(keys.triageDismissals) + Buffer.byteLength(JSON.stringify(rules));
    if (store) await store.setDismissals(rules);
  }

  const total = transcripts + voicemails + (fs.existsSync(dismissalsPath) ? 1 : 0);
  console.log(
    `${dryRun ? '[dry-run] would write' : 'Wrote'} ${total} keys: ${transcripts} transcripts, ${voicemails} voicemails, ` +
      `dismissals (${dismissals} rules) — ${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
