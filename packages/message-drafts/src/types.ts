/**
 * Shared types and constants for the message-drafts pipeline.
 *
 * The pipeline posts Matt-voice draft texts as Quo contact notes for
 * copy/paste send. NOTHING is ever sent to a customer by this code; the
 * note in the conversation panel IS the deliverable.
 *
 * Design: analysis/02-strategy/message-automation-analysis-2026-10.md.
 * Extracted from tools/src/message-drafts/run.ts (2026-10-21, launchd →
 * server-workers P1) so the Vercel worker, the laptop backstop runner,
 * and tests all run the identical logic.
 */
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import type { DraftState } from './state.js';

export const OWN_LINE = '+16176681677';
/** Luc runs the CT office; Matt texts him off-platform. */
export const LUC_LINE = '860-573-8760';
export const CT_AREA_CODES = new Set(['860', '203', '475', '959']);
export const INTERNAL = new Set(['+18573126761', '+16177660151', OWN_LINE]);

/** Matt's preemption window (owner-set 2026-10-19; was 15 in the analysis). */
export const INTAKE_REPLY_WINDOW_MIN = 10;
/** The inquiry itself (first inbound) must be genuinely new. */
export const INTAKE_THREAD_MAX_AGE_H = 48;
export const FOLLOWUP_LOOKBACK_H = 36;
/** ~80 min of retries waiting for a Quo contact to exist. */
export const MAX_NOTE_ATTEMPTS = 8;
export const MAX_DRAFTS_PER_RUN = 6;
/** A `pending:` claim older than this is a crashed actor — reclaimable. */
export const CLAIM_STALE_MIN = 15;

export const REAL_LEAD_RE =
  /crack|basement|foundation|leak|seep|water|bulkhead|quote|estimate|concrete|sump|repair|pool|patio|garage|wall|floor|cellar|slab/i;
export const SPAM_RE =
  /hey,? it.?s \w+\.|homeowners? (in your area|looking|needing|ready)|pay.?per.?(lead|booked)|no (setup|ad) fees|mold removal (jobs|work|quotes)|ranked on google|exclusive.{0,30}(estimates|leads)|appointments? booked|min to apply|book qualified|per booked estimate|trial, no contract|send (you )?\d+ (jobs|leads|homeowners)/i;
export const AUTO_RE =
  /apologies for missing your call|please send us a text with your name|reached out after hours|first thing when we open|this is a reminder from attack a crack|just checking back in to make sure everything/i;
export const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export interface DraftDeps {
  qb: QuickBooksClient;
  quo: QuoClient;
  gemini: GeminiClient;
  state: DraftState;
  /** Injected clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Print drafts instead of posting notes or writing state. */
  dryRun?: boolean;
}

export type DraftRecord = Record<string, unknown>;

export interface RunSummary {
  drafted: number;
  records: DraftRecord[];
}
