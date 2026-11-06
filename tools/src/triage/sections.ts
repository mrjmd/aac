/**
 * Data behind the triage sections that live outside findings[]: quotes
 * awaiting Matt's reply, the stale-quote follow-up queue, and the 7-day bot
 * quote drafts. render.ts draws them; push-items.ts turns them into
 * command-center items (@aac/triage triageCandidates). The row logic lives
 * in @aac/triage; this file is the laptop's file and Redis reads. The
 * stale-quote lists come from Redis (@aac/stale-quotes); file paths are
 * relative to the repo root (cwd). Every loader is empty-safe.
 */

import fs from 'node:fs';
import type { Redis } from '@upstash/redis';
import { RedisStaleQuoteStore } from '@aac/stale-quotes';
import {
  botDraftRows as triageBotDraftRows,
  parseDraftLabels,
  type BotDraftRow,
  type DraftLabel,
  type StaleQuoteLists,
} from '@aac/triage';
import { redisFromEnv } from '../lib/env';

export {
  loadAwaiting,
  type Awaiting,
  type AwaitingEntry,
  type BotDraftRow,
  type DraftLabel,
  type FupDraft,
  type FupQueue,
  type StaleQuoteLists,
} from '@aac/triage';

/** Read both lists once from Redis (needs UPSTASH_REDIS_REST_URL/TOKEN unless a client is passed). */
export async function loadStaleQuoteLists(redis: Redis = redisFromEnv()): Promise<StaleQuoteLists> {
  const store = new RedisStaleQuoteStore(redis);
  const [queue, awaiting] = await Promise.all([store.loadQueue(), store.loadAwaiting()]);
  return { queue, awaiting };
}

/** The legacy laptop quote-drafter shadow-log rows (raw), [] when the file is gone. */
export function loadLegacyBotLog(): Array<Record<string, unknown>> {
  const logPath = 'analysis/data/quote-trigger/shadow-log.jsonl';
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

/** Last 7 days of quote-drafter trigger activity (worker runlog + legacy shadow-log), oldest first. */
export function botDraftRows(workerLog: Array<Record<string, unknown>>): BotDraftRow[] {
  return triageBotDraftRows(workerLog, Date.now(), loadLegacyBotLog());
}

/** The edit-harvester's ownership state per bot draft, by doc number (or estimate id). */
export function loadDraftLabels(): Map<string, DraftLabel> {
  const labelsPath = 'analysis/data/quote-trigger/edit-labels.jsonl';
  if (!fs.existsSync(labelsPath)) return new Map();
  return parseDraftLabels(fs.readFileSync(labelsPath, 'utf8'));
}
