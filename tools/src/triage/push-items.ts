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
import { loadEnv } from '../lib/env';

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
  // Internal numbers (Ed, Mike, the business and agent lines) are never a
  // customer, whichever detector emitted them (d13/d14 had no guard).
  for (const c of all) if (c && !(c.phone && isInternalPhone(c.phone))) byKey.set(c.key, withCluster(c, data.contactClusters ?? {}));
  return [...byKey.values()];
}

/** Stamp the identity cluster so the command center folds one person's items together. */
function withCluster(c: ItemCandidate, clusters: Record<string, string>): ItemCandidate {
  const contacts = [c.phone, ...(c.who?.phones ?? []), ...(c.who?.emails ?? []).map((e) => e.toLowerCase())];
  const cluster = contacts.map((k) => (k ? clusters[k] : undefined)).find(Boolean);
  return cluster ? { ...c, who: { ...c.who, cluster } } : c;
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
