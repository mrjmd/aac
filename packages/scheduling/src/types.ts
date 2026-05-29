/**
 * SchedulingDirective — the unified contract every trigger path produces.
 *
 * Six trigger paths converge on one shape (discriminated by `intent`):
 *   1. QB Estimate.Update webhook       → quote_approved
 *   2. Quo inbound text  (customer)     → quote_approved
 *   3. Quo call transcript (customer)   → quote_approved
 *   4. Quo inbound text  (customer)     → assessment_requested
 *   5. Quo inbound text  (customer)     → callback_opened
 *   6. Quo outbound (Matt)              → manual_schedule
 *
 * Directives are the single hand-off contract. They flow:
 *   normalizer  → Redis shadow queue  → command-center (Crawl)
 *                                    → suggestSlot → executeDirective (Walk/Run)
 *
 * They are transport-safe (only primitive fields + nested primitive
 * structures) so they can round-trip through Redis JSON without losing
 * fidelity.
 */

// ── Trigger source ─────────────────────────────────────────────────

export type TriggerSource =
  | 'qb_webhook'
  | 'quo_text'
  | 'quo_call'
  | 'quo_outbound'
  | 'qb_reconciliation';

// ── Confidence ─────────────────────────────────────────────────────

/**
 * Numeric score in [0, 1] plus the list of signals that contributed.
 * Signal strings are short stable identifiers (e.g. 'qb_signature_verified',
 * 'matching_pd_deal_found', 'single_open_estimate'). Used both for
 * downstream autonomy gating and for backtest analysis.
 */
export interface Confidence {
  score: number;
  signals: string[];
}

// ── Event class ────────────────────────────────────────────────────

/**
 * Maps directly to Google Calendar colorId:
 *   job        → 10 (basil green)
 *   assessment →  3 (grape purple)
 *   callback   →  5 (banana yellow)
 *
 * Color IDs are also encoded in apps/field. See `project_calendar_color_ids` memory.
 */
export type EventClass = 'job' | 'assessment' | 'callback';

// ── Known slot ─────────────────────────────────────────────────────

/**
 * For the manual_schedule path: when Matt indicates a time on a call
 * ("let's get them scheduled Tuesday at 10"), the classifier extracts
 * the slot directly and the slot-suggestion algorithm is bypassed.
 */
export interface KnownSlot {
  startIso: string;
  /** Optional. If absent, duration model fills it in. */
  endIso?: string;
}

// ── Base directive ─────────────────────────────────────────────────

interface BaseDirective {
  /** ULID. Stable for the lifetime of the directive. */
  id: string;
  /** ISO-8601 UTC of when the normalizer fired. */
  createdAt: string;
  source: TriggerSource;
  confidence: Confidence;

  // ── Customer + entity references ──────────────────────────────
  /** E.164. Normalized via @aac/shared-utils/phone. */
  customerPhone: string;
  pdPersonId?: number;
  /** For callbacks, this is the parent_deal_id (the original job's deal). */
  pdDealId?: number;
  qbCustomerId?: string;
  qbEstimateId?: string;

  // ── Scope ──────────────────────────────────────────────────────
  /** LLM-generated, quality-gated. See @aac/scheduling/buildEventDescription. */
  scopeSummary: string;
  /**
   * Null during Crawl (slot suggestion not active).
   * Populated in Walk via @aac/quoting/estimate-duration.
   */
  estimatedDurationHours: number | null;
}

// ── Directive subtypes ─────────────────────────────────────────────

export interface QuoteApprovedDirective extends BaseDirective {
  intent: 'quote_approved';
  eventClass: 'job';
}

export interface AssessmentRequestedDirective extends BaseDirective {
  intent: 'assessment_requested';
  eventClass: 'assessment';
}

export interface CallbackOpenedDirective extends BaseDirective {
  intent: 'callback_opened';
  eventClass: 'callback';
  /** Required. The original job's PD deal — callbacks are child deals. */
  parentDealId: number;
  /** 1 = first callback on the parent, 2 = second, etc. */
  callbackSequence: number;
  originalServiceType?: string;
  originalTechnician?: string;
}

export interface ManualScheduleDirective extends BaseDirective {
  intent: 'manual_schedule';
  /** Manual-schedule can apply to any event class. */
  eventClass: EventClass;
  /** Present when Matt indicated an explicit time. */
  knownSlot?: KnownSlot;
}

export type SchedulingDirective =
  | QuoteApprovedDirective
  | AssessmentRequestedDirective
  | CallbackOpenedDirective
  | ManualScheduleDirective;

export type DirectiveIntent = SchedulingDirective['intent'];

// ── Discriminator helpers ──────────────────────────────────────────

export function isQuoteApproved(d: SchedulingDirective): d is QuoteApprovedDirective {
  return d.intent === 'quote_approved';
}

export function isAssessmentRequested(
  d: SchedulingDirective,
): d is AssessmentRequestedDirective {
  return d.intent === 'assessment_requested';
}

export function isCallbackOpened(d: SchedulingDirective): d is CallbackOpenedDirective {
  return d.intent === 'callback_opened';
}

export function isManualSchedule(d: SchedulingDirective): d is ManualScheduleDirective {
  return d.intent === 'manual_schedule';
}

// ── Normalizer dependency bundle ───────────────────────────────────

import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';

/**
 * Injected into every normalize-* function. Constructed once at the
 * boundary (middleware webhook handler, backtest harness CLI) and passed
 * through. Mirrors the pattern in @aac/agent-tools/types.
 */
export interface NormalizerDeps {
  pd: PipedriveClient;
  qb: QuickBooksClient;
  quo: QuoClient;
  /**
   * ULID factory injected for testability. Production uses a real ULID
   * generator; tests inject a deterministic counter.
   */
  newId: () => string;
  /** Same pattern for the `createdAt` clock — inject `() => new Date()`. */
  now: () => Date;
}
