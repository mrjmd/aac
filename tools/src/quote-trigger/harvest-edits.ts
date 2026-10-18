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
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { keys, ttl } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import { diffDraftLines } from '@aac/quoting';

const RUNLOG_PATH = 'analysis/data/triage/drafts.json';
const OUT_PATH = 'analysis/data/quote-trigger/edit-labels.jsonl';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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
  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async () =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === 'OK',
      release: async () => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  });

  if (!fs.existsSync(RUNLOG_PATH)) {
    console.log('no run log yet');
    return;
  }
  const runs = JSON.parse(fs.readFileSync(RUNLOG_PATH, 'utf8')) as Array<{
    ranAt: string;
    dryRun: boolean;
    records: Array<{ outcome: string; estimateId?: string; docNumber?: string; customer?: string; phone?: string; total?: number; lines?: Array<{ item: string; qty: number; unitPrice: number }> }>;
  }>;

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
  console.log(`${botDrafts.size} bot draft(s) in run log`);

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
        // diffDraftLines(current, draftLines) yields draft-relative signs;
        // invert so signs describe what the OWNER did to the bot draft.
        ownerChanges = diffDraftLines(current, d.lines).map((c) =>
          c.startsWith('+') ? `owner REMOVED ${c.slice(2)}` :
          c.startsWith('−') ? `owner ADDED ${c.slice(2).replace(' removed', '')}` :
          c.replace('~', 'owner CHANGED').replace('→', '←'),
        );
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
