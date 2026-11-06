/**
 * A triage run as command-center item candidates (keys.itemCandidates).
 * Moved verbatim from tools/src/triage/push-items.ts and sections.ts
 * (2026-11-05); file reads and the clock come in from the caller.
 *
 * Besides findings[], a run carries the three sections that live in their
 * own places: quotes awaiting Matt's reply, the stale-quote follow-up queue
 * and its flags (both from @aac/stale-quotes's saved lists), and the 7-day
 * bot quote drafts (the quote-drafter runlog in findings.json, plus the
 * legacy laptop shadow-log when a caller has it).
 */

import { isInternalPhone } from '@aac/shared-utils/phone';
import {
  fromAwaitingQuote,
  fromBotDraft,
  fromFollowupDraft,
  fromFunnelFlag,
  fromTriageFinding,
  ItemStore,
  type ItemCandidate,
  type ItemRedis,
} from '@aac/items';
import type { FindingsFile } from './types.js';

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

/**
 * Pending quotes where the CUSTOMER spoke last and never got an answer.
 * Applies the same booked-customer cross-reference analyze uses for
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
 * shadow-log rows (analysis/data/quote-trigger/shadow-log.jsonl, parsed by
 * the caller; none in the cloud) until they age out of the window.
 */
export function botDraftRows(
  workerLog: Array<Record<string, unknown>>,
  now: number,
  legacyLog: Array<Record<string, unknown>> = [],
): BotDraftRow[] {
  const weekAgo = now - 7 * 86_400_000;
  const legacyRows = legacyLog
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

/** edit-labels.jsonl lines → label per doc number (or estimate id); later lines win. */
export function parseDraftLabels(jsonl: string): Map<string, DraftLabel> {
  return new Map(
    jsonl
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const d = JSON.parse(l) as DraftLabel;
        return [String(d.docNumber ?? d.estimateId), d] as const;
      }),
  );
}

export interface TriageCandidateContext {
  /** The clock for the 7-day bot-draft window (ms). */
  now: number;
  /**
   * The edit-harvester's ownership state per bot draft (edit-labels.jsonl).
   * A labelled draft Matt already edited, sent or deleted is dropped. The
   * laptop passes the file; the cloud has none, so every draft shows.
   */
  labels?: Map<string, DraftLabel>;
  /** Raw legacy shadow-log rows (laptop only). */
  legacyBotLog?: Array<Record<string, unknown>>;
}

/** Every item a triage run implies. Later duplicates of a key win (newest bot-draft row). */
export function triageCandidates(data: FindingsFile, stale: StaleQuoteLists, ctx: TriageCandidateContext): ItemCandidate[] {
  const queue = stale.queue;
  const labels = ctx.labels ?? new Map<string, DraftLabel>();
  const external = (p: { phone: string }) => !isInternalPhone(p.phone);
  const all: Array<ItemCandidate | null> = [
    ...data.findings.map(fromTriageFinding),
    ...(loadAwaiting(data.booked ?? [], stale.awaiting)?.entries ?? []).filter(external).map(fromAwaitingQuote),
    ...(queue?.toSend ?? []).map((d) => fromFollowupDraft(d, false)),
    ...(queue?.waiting ?? []).map((d) => fromFollowupDraft(d, true)),
    ...(queue?.flags ?? []).map(fromFunnelFlag),
    // A draft Matt already edited, sent or deleted is reviewed; name the rest.
    ...botDraftRows(data.quoteDrafterRunlog ?? [], ctx.now, ctx.legacyBotLog)
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

export interface PublishTriageItemsDeps {
  redis: ItemRedis;
}

/**
 * Publish candidates to keys.itemCandidates. `source` names the writer
 * ('triage-laptop' from the CLI, 'triage-worker' from the cron).
 */
export async function publishTriageItems(
  deps: PublishTriageItemsDeps,
  run: { at: string; source: string; candidates: ItemCandidate[] },
): Promise<void> {
  await new ItemStore(deps.redis).putCandidates({ at: run.at, source: run.source, candidates: run.candidates });
}
