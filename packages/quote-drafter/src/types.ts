/**
 * Shared types + constants for the quote-drafter pipeline (launchd →
 * server-workers P2). Ported from tools/src/quote-trigger/shadow.ts and
 * tools/src/drafter/run.ts; the laptop CLI and the cloud worker both run
 * this package against shared Redis state.
 */
import type { Redis } from '@upstash/redis';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import type { ExemplarLibraryEntry } from '@aac/quoting';

// ── trigger events (shape produced by middleware's Quo webhook) ────────

export interface TriggerEvent {
  phone: string;
  direction: 'incoming' | 'outgoing';
  at: string;
  hasMedia: boolean;
  snippet: string;
  kind?: 'message' | 'mike-debrief';
}

/** Settle window: a burst of messages drafts once, after it goes quiet. */
export const DEBOUNCE_MS = 15 * 60 * 1000;

/** Internal numbers that must never trigger a customer quote analysis. */
export const INTERNAL = new Set(['+18573126761', '+16177660151', '+16176681677']);

export const QUOTE_PROMISE_RE =
  /\b(quote|estimate|price|write (it|that|this) up|get (that|you|a) (quote|estimate|price|number))\b/i;

/**
 * Post-send language — an outbound text ABOUT a quote that already went
 * out is not a promise to produce one. Added 2026-10-21 after T3 fired on
 * Matt's own bot-drafted follow-up ("I just sent that quote over…") and
 * minted a duplicate John Skinner estimate.
 */
export const POST_SEND_RE =
  /\b(just|already)\s+(sent|emailed|shot)\b|\bsent\s+(that|the|your|it)\b|\b(quote|estimate)\b[^.?!]{0,40}\b(is\s+)?(sent|on\s+its\s+way|in\s+your\s+(inbox|email))\b/i;

/** Cap live drafts per run — a backlog flood should trickle, not burst. */
export const MAX_DRAFTS_PER_RUN = 5;

/** Safety valve: max queue events drained per run. */
export const MAX_DRAIN_PER_RUN = 500;

// ── T2 (Mike debrief → draft the visited customers) ────────────────────

export const T2_VISIT_LOOKBACK_H = 36;
export const T2_DEDUPE_H = 24;

// ── drafter constants (ported verbatim from tools/src/drafter/run.ts) ──

export const EXEMPLARS_PER_AREA = 3;
export const MAX_PHOTOS = 6;
export const MIKE_PHONE = '+18573126761';
export const MIKE_EMAILS = new Set(['mike@attackacrack.com', 'harrringtonm@gmail.com']);
export const FIELD_LOOKBACK_DAYS = 60;
export const MAX_TECH_PHOTOS = 4;
export const MAX_DEBRIEF_CALLS = 3;
export const MAX_TRANSCRIPT_CHARS = 8_000;
export const MAX_THREAD_MESSAGES = 100;

/** Trigger-runner guard: never stack a draft next to an estimate newer than this. */
export const SKIP_IF_RECENT_ESTIMATE_DAYS = 30;

// ── classification ─────────────────────────────────────────────────────

export interface TriggerVerdict {
  trigger: 'T1' | 'T3';
  why: string;
}

export function classify(events: TriggerEvent[]): TriggerVerdict | null {
  const inboundMedia = events.filter((e) => e.direction === 'incoming' && e.hasMedia);
  if (inboundMedia.length) {
    return { trigger: 'T1', why: `${inboundMedia.length} inbound photo message(s)` };
  }
  const promise = events.find(
    (e) =>
      e.direction === 'outgoing' &&
      QUOTE_PROMISE_RE.test(e.snippet) &&
      !POST_SEND_RE.test(e.snippet),
  );
  if (promise) {
    return { trigger: 'T3', why: `outbound quote promise: "${promise.snippet.slice(0, 80)}"` };
  }
  return null;
}

// ── dependency + asset injection ───────────────────────────────────────

export interface DrafterAssets {
  /** Canonical pricing ruleset (SECTION 0) — required. */
  rulesetText: string;
  /** Visual ruleset (Section V draft) — optional, photo layer. */
  sectionVText?: string;
  /** Embedded exemplar library — optional, photo layer. */
  exemplarLibrary: ExemplarLibraryEntry[];
}

export interface DrafterDeps {
  redis: Redis;
  qb: QuickBooksClient;
  quo: QuoClient;
  gemini: GeminiClient;
  /** Optional — absence disables the field-context channel + T2. */
  calendar: GoogleCalendarClient | null;
  /** Optional — absence disables technician event-photo retrieval. */
  drive: GoogleDriveClient | null;
  /** Progress lines (CLI prints them; worker folds them into the runlog). */
  log: (line: string) => void;
  now: () => number;
}

// ── finding + outcome shapes ───────────────────────────────────────────

/** The one-customer unit of drafting work (was a triage Finding). */
export interface QuoteFinding {
  phone: string;
  customer: string | null;
  title: string;
}

export interface DraftRunRecord {
  phone: string;
  customer: string;
  outcome: 'created' | 'updated' | 'dry-run' | 'skipped' | 'failed';
  detail: string;
  estimateId?: string;
  docNumber?: string;
  total?: number;
  /** The bot's drafted lines — the baseline the edit-harvester diffs
   *  owner changes against (the passive training-label loop). */
  lines?: Array<{ item: string; qty: number; unitPrice: number }>;
}

/** One runlog entry per trigger firing (Redis LPUSH + LTRIM). */
export interface TriggerRunlogEntry {
  at: string;
  mode: 'shadow' | 'live';
  phone: string;
  trigger: 'T1' | 'T2' | 'T3' | 'none';
  why?: string;
  events: number;
  record?: DraftRunRecord;
  logTail?: string;
}

export type DrafterMode = 'off' | 'shadow' | 'live';
