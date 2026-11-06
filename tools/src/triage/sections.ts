/**
 * Data behind the triage sections that live outside findings[]: quotes
 * awaiting Matt's reply, the stale-quote follow-up queue, and the 7-day bot
 * quote drafts. render.ts draws them; tools/src/triage/push-items.ts turns
 * them into command-center items. One reader each, so both show the same rows.
 * The stale-quote lists come from Redis (@aac/stale-quotes); file paths are
 * relative to the repo root (cwd). Every loader is empty-safe.
 */

import fs from 'node:fs';
import { RedisStaleQuoteStore } from '@aac/stale-quotes';
import type { FindingsFile } from './analyze.ts';
import { redisFromEnv } from '../lib/env';

type Booked = NonNullable<FindingsFile['booked']>;

export interface AwaitingEntry {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  channel: string;
  lastInboundAt: string;
  daysWaiting: number;
  snippet: string;
}

export interface Awaiting {
  generatedAt: string;
  entries: AwaitingEntry[];
  /** Entries dropped because the customer has since booked a job. */
  hiddenBooked: Array<{ entry: AwaitingEntry; event: string }>;
}

/** The stale-quote runner's saved lists: its draft queue and quotes awaiting Matt's reply. */
export interface StaleQuoteLists {
  queue: FupQueue | null;
  awaiting: { generatedAt: string; entries: AwaitingEntry[] } | null;
}

/** Read both lists once from Redis (needs UPSTASH_REDIS_REST_URL/TOKEN). */
export async function loadStaleQuoteLists(): Promise<StaleQuoteLists> {
  const store = new RedisStaleQuoteStore(redisFromEnv());
  const [queue, awaiting] = await Promise.all([store.loadQueue(), store.loadAwaiting()]);
  return { queue, awaiting };
}

/**
 * Pending quotes where the CUSTOMER spoke last and never got an answer.
 * Applies the same booked-customer cross-reference analyze.ts uses for
 * findings: an upcoming green job booked on/after (their last inbound − 7d)
 * is closed business, not a quote waiting on a reply.
 */
export function loadAwaiting(booked: Booked, data: StaleQuoteLists['awaiting']): Awaiting | null {
  if (!data || !Array.isArray(data.entries)) return null;
  const bookedFor = (a: AwaitingEntry): Booked[number] | undefined =>
    booked.find(
      (b) =>
        b.phones.includes(a.phone) &&
        (!b.createdAt || new Date(b.createdAt).getTime() >= new Date(a.lastInboundAt).getTime() - 7 * 86_400_000),
    );
  const entries: AwaitingEntry[] = [];
  const hiddenBooked: Awaiting['hiddenBooked'] = [];
  for (const a of data.entries) {
    const b = bookedFor(a);
    if (b) hiddenBooked.push({ entry: a, event: b.event });
    else entries.push(a);
  }
  return { generatedAt: data.generatedAt, entries, hiddenBooked };
}

export interface FupDraft {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  ageDays: number;
  tier: string;
  variant: string;
  draft: string;
  whyNow: string;
  queuedAt: string;
}

export interface FupQueue {
  generatedAt: string;
  bookingHorizon: string;
  toSend: FupDraft[];
  waiting: FupDraft[];
  flags: Array<{ kind: string; doc: string; customer: string; amount: number; detail: string }>;
}

export interface BotDraftRow {
  at: string;
  trigger: string;
  phone: string;
  outcome: string;
  createdDoc?: string;
  total?: number;
  why?: string;
  scopeItems?: string[];
  gate: { label: string; wouldAutoCreate: boolean };
}

/**
 * Last 7 days of quote-drafter trigger activity, oldest first: the worker's
 * Redis runlog (passed through findings.json) plus the legacy laptop
 * shadow-log until it ages out of the window.
 */
export function botDraftRows(workerLog: Array<Record<string, unknown>>): BotDraftRow[] {
  const logPath = 'analysis/data/quote-trigger/shadow-log.jsonl';
  const weekAgo = Date.now() - 7 * 86_400_000;
  const legacyRows = (
    fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : []
  )
    .filter((r) => new Date(String(r.at)).getTime() >= weekAgo && r.outcome !== 'no-trigger')
    .map((r) => r as unknown as BotDraftRow);
  // Worker TriggerRunlogEntry → the row shape the section always rendered.
  const workerRows: BotDraftRow[] = workerLog
    .filter((e) => e.trigger && e.trigger !== 'none' && new Date(String(e.at)).getTime() >= weekAgo)
    .map((e) => {
      const rec = (e.record ?? {}) as Record<string, unknown>;
      const outcome = String(rec.outcome ?? 'failed');
      return {
        at: String(e.at),
        trigger: String(e.trigger),
        phone: String(e.phone ?? ''),
        outcome: outcome === 'failed' ? 'draft-failed' : outcome,
        createdDoc: rec.docNumber as string | undefined,
        total: rec.total as number | undefined,
        why: (e.why as string | undefined) ?? (rec.detail as string | undefined),
        scopeItems: Array.isArray(rec.lines) ? (rec.lines as Array<{ item: string }>).map((l) => l.item) : undefined,
        gate: { label: `worker · ${String(e.mode ?? '')}`, wouldAutoCreate: outcome === 'created' || outcome === 'updated' },
      };
    });
  return [...legacyRows, ...workerRows].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export interface DraftLabel {
  docNumber?: string;
  estimateId: string;
  customer: string;
  /** untouched · owner-edited · sent/accepted · deleted (harvest-edits.ts). */
  state: string;
}

/** The edit-harvester's ownership state per bot draft, by doc number (or estimate id). */
export function loadDraftLabels(): Map<string, DraftLabel> {
  const labelsPath = 'analysis/data/quote-trigger/edit-labels.jsonl';
  if (!fs.existsSync(labelsPath)) return new Map();
  return new Map(
    fs
      .readFileSync(labelsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const d = JSON.parse(l) as DraftLabel;
        return [String(d.docNumber ?? d.estimateId), d] as const;
      }),
  );
}
