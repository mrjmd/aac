/**
 * Lead leaks: people who asked for work and never got a quote because we
 * dropped them (round-2 plan §3, "Missed" revenue). Three stages:
 *
 * - `no_reply`  (A): asked, never got a human answer, no photos or info yet
 * - `no_quote`  (B): sent photos or info (or talked scope), never got a quote
 * - `assessed`  (C): we visited, never quoted
 *
 * Everything else a thread can be (quoted, booked, went quiet after our ask,
 * a solicitation, declined, CT) is counted but not listed as a leak.
 */

export type LeakStage = 'no_reply' | 'no_quote' | 'assessed';

export type ExcludeReason =
  | 'solicitation'
  | 'existing_customer'
  | 'declined'
  | 'deferred'
  | 'ct'
  | 'phone_tag'
  | 'other';

export type Scope = 'crack' | 'bulkhead' | 'pipe' | 'stairs' | 'slab' | 'garage_floor' | 'multi' | 'unknown';

/** The model's read of one thread. */
export interface Verdict {
  status: LeakStage | 'quiet' | 'quoted_or_booked' | 'excluded';
  exclude?: ExcludeReason | null;
  name: string | null;
  askedFor: string;
  whyStuck: string;
  scope: Scope;
}

/**
 * One thread's read, cached per phone and reused until the thread moves (or
 * an assessment lands on the calendar). `facts` null = nothing from them in
 * the window; `verdict` null = not read by the model (no inbound).
 */
export interface CachedVerdict {
  lastActivityAt: string;
  assessed: string | null;
  facts: ThreadFacts | null;
  verdict: Verdict | null;
  at: string;
}

/** Mechanical facts about a thread, read straight from Quo. */
export interface ThreadFacts {
  firstAt: string;
  lastAt: string;
  lastWho: 'them' | 'us';
  /** Last customer message or call, in a few words. */
  lastText: string;
  lastInboundAt: string | null;
  inboundTexts: number;
  photos: number;
  /** Only missed or unanswered calls from them: no text, no voicemail, no talk. */
  missedOnly: boolean;
}

export interface LeakRow {
  phone: string;
  name: string | null;
  stage: LeakStage;
  firstAt: string;
  lastAt: string;
  lastWho: 'them' | 'us';
  lastText: string;
  askedFor: string;
  whyStuck: string;
  photos: number;
  value: number;
  /** How `value` was worked out, in words. */
  valueBasis: string;
  /** The thread's lastActivityAt: "handled" holds until it moves. */
  lastActivityAt: string;
}

export interface QuietRow {
  phone: string;
  name: string | null;
  askedFor: string;
  lastAt: string;
}

export interface LeadLeakSnapshot {
  builtAt: string;
  windowDays: number;
  rows: LeakRow[];
  quiet: QuietRow[];
  /** Threads read but not leaks, by why. */
  counts: Record<'quoted_or_booked' | ExcludeReason, number>;
  /** Threads looked at this run (1:1 with a customer message in the window). */
  threads: number;
  /** Fresh model reads this run (the rest came from the cache). */
  llmCalls: number;
  partial: boolean;
  gaps: string[];
}
