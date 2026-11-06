#!/usr/bin/env npx tsx
/**
 * Passive training-label harvester (photo-quote-training flywheel).
 *
 * Every bot draft the owner edits, sends, or deletes is a labeled
 * correction. This scans the drafter run log for created/updated bot
 * drafts, fetches their current QBO state, and records what the owner
 * changed: line-level diffs, status transitions, deletions. Output feeds
 * the next Section V re-distillation as owner-correction evidence.
 *
 * Output: analysis/data/quote-trigger/edit-labels.jsonl (latest state per
 * estimate — rewritten each run, safe to re-run any time, e.g. weekly or
 * before a re-distill).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { ownerChanges as diffOwnerChanges } from '@aac/grader';
import { loadEnv, quickBooksFromEnv, redisFromEnv } from '../lib/env';

const RUNLOG_PATH = 'analysis/data/triage/drafts.json';
const OUT_PATH = 'analysis/data/quote-trigger/edit-labels.jsonl';

async function main(): Promise<void> {
  loadEnv();
  const redis = redisFromEnv();
  const qb = quickBooksFromEnv(redis);

  type DraftRecord = { outcome: string; estimateId?: string; docNumber?: string; customer?: string; phone?: string; total?: number; lines?: Array<{ item: string; qty: number; unitPrice: number }> };
  const runs = fs.existsSync(RUNLOG_PATH)
    ? (JSON.parse(fs.readFileSync(RUNLOG_PATH, 'utf8')) as Array<{
        ranAt: string;
        dryRun: boolean;
        records: DraftRecord[];
      }>)
    : [];

  // latest bot-written state per estimate (updated supersedes created)
  const botDrafts = new Map<string, { at: string; customer?: string; phone?: string; total?: number; docNumber?: string; lines?: Array<{ item: string; qty: number; unitPrice: number }> }>();
  for (const run of runs) {
    if (run.dryRun) continue;
    for (const r of run.records) {
      if ((r.outcome === 'created' || r.outcome === 'updated') && r.estimateId) {
        botDrafts.set(r.estimateId, { at: run.ranAt, customer: r.customer, phone: r.phone, total: r.total, docNumber: r.docNumber, lines: r.lines });
      }
    }
  }

  // Cloud-worker drafts (P2): the worker's Redis runlog carries the same
  // record shape inside TriggerRunlogEntry. Older entries may have been
  // LTRIMmed away, but harvest runs often enough (weekly) to catch them.
  const redisLog = await redis.lrange<string | { at: string; mode: string; record?: DraftRecord }>(
    keys.quoteDrafterRunlog, 0, -1,
  );
  for (const raw of redisLog ?? []) {
    const entry = typeof raw === 'string' ? (JSON.parse(raw) as { at: string; mode: string; record?: DraftRecord }) : raw;
    const r = entry.record;
    if (entry.mode !== 'live' || !r || !r.estimateId) continue;
    if (r.outcome !== 'created' && r.outcome !== 'updated') continue;
    const prior = botDrafts.get(r.estimateId);
    if (prior && prior.at > entry.at) continue; // local log already newer
    botDrafts.set(r.estimateId, { at: entry.at, customer: r.customer, phone: r.phone, total: r.total, docNumber: r.docNumber, lines: r.lines });
  }
  console.log(`${botDrafts.size} bot draft(s) across local + worker run logs`);
  if (botDrafts.size === 0) {
    console.log('no run log yet');
    return;
  }

  const out: string[] = [];
  const counts: Record<string, number> = {};
  for (const [estimateId, d] of botDrafts) {
    let current = null;
    try {
      current = await qb.getEstimate(estimateId);
    } catch (err) {
      // QBO reports deleted estimates as 400/610 Object Not Found
      if (!/610|Object Not Found/i.test(String(err))) throw err;
    }
    let state: string;
    let ownerChanges: string[] = [];
    if (!current) {
      state = 'deleted'; // owner deleted it — a rejection label
    } else {
      const stored = await redis.get(keys.quoteDraftSyncToken(estimateId));
      const botOwned = stored !== null && stored !== undefined && String(stored) === String(current.SyncToken);
      if (current.TxnStatus !== 'Pending') {
        state = `sent/${current.TxnStatus?.toLowerCase()}`; // owner accepted enough to send
      } else {
        state = botOwned ? 'untouched' : 'owner-edited';
      }
      if (!botOwned && d.lines) {
        // ignores the Guarantee line the drafter appends itself
        ownerChanges = diffOwnerChanges(current, d.lines);
      }
    }
    counts[state] = (counts[state] ?? 0) + 1;
    out.push(JSON.stringify({
      estimateId,
      docNumber: d.docNumber,
      customer: d.customer,
      phone: d.phone,
      draftedAt: d.at,
      botTotal: d.total,
      currentTotal: current?.TotalAmt ?? null,
      state,
      ownerChanges,
    }));
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out.join('\n') + (out.length ? '\n' : ''));
  console.log('states:', counts);
  console.log(`wrote ${out.length} label(s) → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
