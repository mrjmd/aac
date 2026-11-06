/**
 * Stale-quote follow-up: constants, state shapes and dependencies.
 * Plan: analysis/02-strategy/stale-quote-followup-plan-2026-10.md.
 */
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GmailClient } from '@aac/api-clients/gmail';
import type { ConditionName } from '@aac/shared-utils/health';
import type { StaleQuoteStore } from './state.js';

// ── config ───────────────────────────────────────────────────────────

export const MAX_DRAFTS_PER_RUN = 6;
export const QUO_THROTTLE_MS = 220; // 10 req/s hard limit — stay well under
export const MAX_UNANSWERED = 3; // consecutive unanswered touches, then stop
export const FINAL_AGE_OUT_DAYS = 14; // final touch unanswered this long → close flag
export const RECENT_OUTBOUND_COOLOFF_H = 48; // any outbound this fresh → not this run
export const OUR_EMAILS = new Set(['matt@attackacrack.com', 'attackacrackma@gmail.com']);
/** DocNumbers never touched by automation (owner holds). A hold with
 *  `until` resurfaces on that date as a needs-call flag: Matt follows up
 *  personally, never the automated ladder. */
export const MANUAL_HOLDS = new Map<string, { why: string; until?: string }>([
  ['1523', { why: 'Michael Fridman: scope confusion, deliberate pause' }],
  // Outdoor resurfacing, can't be done until it warms up (owner, 2026-11-05).
  ['1499', { why: 'Mityushin pool deck: personal spring follow-up', until: '2027-03-01' }],
  ['1493', { why: 'Mulvaney stairs: personal spring follow-up', until: '2027-03-01' }],
]);

// A/B variants (plan §4.7): stable hash of estimate ID picks the cell.
export const T1_VARIANTS = [2, 3]; // days after quote
export const T2_VARIANTS = [10, 14]; // days after quote (min 7d after T1 send)
export const T3_GAP_DAYS = 21; // after T2 send
// Quotes this old skip T1/T2 and get one honest "last check-in" (the T3
// closer), then a recommend-close flag if it goes unanswered (owner,
// 2026-11-05; funnel data: 90% of wins close within a week of the quote).
export const LAST_CHECKIN_AGE_DAYS = 90;
export const LAST_CHECKIN_GAP_DAYS = 7; // after our last outbound
// Matt's capacity rule (10/21): it's about SQUARE FOOTAGE, not dollars.
// Stated footage wins — over 300 sq ft is a hold ("not even interested in
// taking on 400 sq ft"; the 450 two-car garage holds, the 285 basement
// floor releases). Stair-only work is fine up to $6k (a staircase or two);
// the ~30-staircase apartment package stays held via that cap. Dollar
// fallback only when no footage is stated anywhere on the resurf lines.
export const CAPACITY_SQFT_MAX = 300;
export const CAPACITY_STAIR_USD = 6000;
export const CAPACITY_RESURF_LARGE_USD = 2500; // fallback when no sq ft stated

export const DAY = 86_400_000;
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ── types ────────────────────────────────────────────────────────────

export type SuspendReason =
  | 'booked'
  | 'capacity-hold'
  | 'awaiting-human'
  | 'manual-hold'
  | 'stated-timing'
  | 'season'
  | 'no-sms-channel';

export interface TouchRecord {
  tier: 'T1' | 'T2' | 'T3';
  queuedAt: string;
  draft: string;
  sentDetectedAt?: string;
  repliedWithin7d?: boolean;
}

export type ServiceClass = 'pool-deck' | 'exterior-resurf' | 'garage-interior' | 'injection';

export interface EstimateState {
  estimateId: string;
  doc: string;
  customer: string;
  phone: string | null;
  firstSeenAt: string;
  seasonClass: ServiceClass;
  largeResurf: boolean;
  variant: { t1Days: number; t2Days: number };
  suspended?: { reason: SuspendReason; detail: string; at: string; until?: string };
  statedTiming?: { resumeAt: string; evidence: string; channel: string; extractedAt: string };
  /** Last inbound timestamp the intent extractor has already seen. */
  lastExtractedInboundAt?: string;
  /** Extractor's verdict on that inbound: does it still need Matt's reply?
   *  false = polite sign-off ("thanks, I'll get back to you"), so the ladder
   *  may continue. Owner decision 2026-11-05. */
  lastInboundNeedsReply?: boolean;
  touches: TouchRecord[];
  closedFlag?: { kind: 'age-out' | 'declined'; detail: string; at: string };
}

export interface FunnelStateFile {
  updatedAt: string;
  estimates: Record<string, EstimateState>;
}

export interface QueueDraft {
  doc: string;
  estimateId: string;
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

export interface QueueFlag {
  kind: 'flip-accepted' | 'recommend-close' | 'needs-call' | 'capacity-hold';
  doc: string;
  customer: string;
  amount: number;
  detail: string;
}

export interface QueueFile {
  generatedAt: string;
  bookingHorizon: string;
  toSend: QueueDraft[];
  waiting: QueueDraft[]; // queued earlier, no matching outbound detected yet
  flags: QueueFlag[];
  skipped: Array<{ doc: string; customer: string; reason: string }>;
}

/** Pending quotes where the customer's last message went unanswered — the bot
 *  stays out, but these are the hottest list in the pool for a human. Written
 *  on every full scan (dry or live) for the triage report and command center. */
export interface AwaitingHumanEntry {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  channel: 'sms' | 'email';
  lastInboundAt: string; // ISO day
  daysWaiting: number;
  snippet: string;
}

export interface AwaitingFile {
  generatedAt: string;
  entries: AwaitingHumanEntry[];
}

export type RunlogRow = Record<string, unknown>;

export interface StaleQuoteDeps {
  qb: Pick<QuickBooksClient, 'query' | 'getEstimate'>;
  quo: Pick<QuoClient, 'listMessages' | 'listCalls' | 'findContactByPhone' | 'createContactNote'>;
  gemini: Pick<GeminiClient, 'generateContent'>;
  /** Calendar + Gmail are HARD gates (plan §4.3 gates 2 & 5): no degraded mode. */
  calendar: Pick<GoogleCalendarClient, 'listEvents'>;
  gmail: Pick<GmailClient, 'listMessages'>;
  store: StaleQuoteStore;
  /** technicianEmails(process.env.TECHNICIAN_EMAILS). */
  techEmails: readonly string[];
  log: (line: string) => void;
  now?: () => number;
  /** Pause between Quo calls (default QUO_THROTTLE_MS; tests pass 0). */
  throttleMs?: number;
  /** Count a silent skip for the System health page (worker: @aac/shared-utils/health countCondition). Never throws. */
  countCondition?: (name: ConditionName) => Promise<void>;
}

export interface RunOptions {
  dryRun: boolean;
  /** One estimate by DocNumber (no awaiting refresh, no prune). */
  doc?: string;
  maxDrafts?: number;
  /** Epoch ms: stop starting new estimates after this (worker time budget). */
  deadlineMs?: number;
}

export interface RunResult {
  /** True when the deadline stopped the scan early: state saved, queue/awaiting kept from the last full run. */
  partial: boolean;
  horizon: string;
  queue: QueueFile;
  awaiting: AwaitingHumanEntry[];
  runlog: RunlogRow[];
  pendingInScope: number;
}
