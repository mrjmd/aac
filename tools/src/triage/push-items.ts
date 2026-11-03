#!/usr/bin/env npx tsx
/**
 * Bridge: publish a triage run as command-center item candidates, so the
 * command center shows what triage.html shows. analyze.ts calls this after
 * writing findings.json (skip with --no-push); run it by hand to re-push the
 * last run. Retire once the cloud worker writes keys.itemCandidates itself
 * (docs/plans/command-center/README.md §9, Phase 1 step 3).
 *
 *   npx tsx tools/src/triage/push-items.ts [--dry-run]
 *
 * Besides findings[], it carries the three sections that live in their own
 * files (sections.ts): quotes awaiting Matt's reply, the stale-quote
 * follow-up queue and its flags, and the 7-day bot quote drafts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from '@upstash/redis';
import { isInternalPhone } from '@aac/shared-utils/phone';
import {
  fromAwaitingQuote,
  fromBotDraft,
  fromFollowupDraft,
  fromFunnelFlag,
  fromTriageFinding,
  ItemStore,
  type ItemCandidate,
} from '@aac/items';
import type { FindingsFile } from './analyze.ts';
import { botDraftRows, loadAwaiting, loadDraftLabels, loadFollowupQueue } from './sections.ts';

/** Every item a triage run implies. Later duplicates of a key win (newest bot-draft row). */
export function triageCandidates(data: FindingsFile): ItemCandidate[] {
  const queue = loadFollowupQueue();
  const labels = loadDraftLabels();
  const external = (p: { phone: string }) => !isInternalPhone(p.phone);
  const all: Array<ItemCandidate | null> = [
    ...data.findings.map(fromTriageFinding),
    ...(loadAwaiting(data.booked ?? [])?.entries ?? []).filter(external).map(fromAwaitingQuote),
    ...(queue?.toSend ?? []).map((d) => fromFollowupDraft(d, false)),
    ...(queue?.waiting ?? []).map((d) => fromFollowupDraft(d, true)),
    ...(queue?.flags ?? []).map(fromFunnelFlag),
    // A draft Matt already edited, sent or deleted is reviewed; name the rest.
    ...botDraftRows(data.quoteDrafterRunlog ?? [])
      .filter(external)
      .map((r) => ({ ...r, label: r.createdDoc ? labels.get(String(r.createdDoc)) : undefined }))
      .filter((r) => !r.label || r.label.state === 'untouched')
      .map((r) => fromBotDraft({ ...r, customer: r.label?.customer })),
  ];
  const byKey = new Map<string, ItemCandidate>();
  for (const c of all) if (c) byKey.set(c.key, c);
  return [...byKey.values()];
}

/** Publish to keys.itemCandidates. Needs UPSTASH_REDIS_REST_URL/TOKEN in env. */
export async function pushItems(data: FindingsFile, opts: { dryRun?: boolean } = {}): Promise<void> {
  const candidates = triageCandidates(data);
  const byDetector = candidates.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.detector]: (acc[c.detector] ?? 0) + 1 }), {});
  console.log(`${candidates.length} item candidates from triage run ${data.generatedAt}`, byDetector);
  if (opts.dryRun) return;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing env: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  await new ItemStore(new Redis({ url, token })).putCandidates({ at: data.generatedAt, source: 'triage-laptop', candidates });
  console.log('Published to keys.itemCandidates');
}

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
