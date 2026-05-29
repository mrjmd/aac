/**
 * normalizeManualSchedule — turn Matt's outbound text/call into a
 * ManualScheduleDirective.
 *
 * The manual-schedule path fires when middleware's Gemini classifier
 * detects scheduling intent in Matt's *outbound* communication
 * ("let's get them scheduled Tuesday at 10"). Customer state has
 * already been resolved by the webhook handler; this normalizer just
 * assembles a directive from classifier output + customer references.
 *
 * Pure function. No I/O. No client calls. The classifier ran upstream;
 * the customer lookup ran upstream; this just packages.
 */

import { normalizePhone } from '@aac/shared-utils/phone';
import type {
  Confidence,
  EventClass,
  KnownSlot,
  ManualScheduleDirective,
  NormalizerDeps,
} from './types.js';

/** What the Gemini classifier extracted from Matt's outbound message. */
export interface ManualScheduleClassification {
  /** Score from the classifier in [0, 1]. */
  score: number;
  /** Inferred event class from context — defaults to 'job' if absent. */
  eventClass?: EventClass;
  /** Parsed time if the classifier extracted one. */
  knownSlot?: KnownSlot;
  /** LLM scope summary, or '' if the classifier produced none. */
  scopeSummary?: string;
}

/** Customer + entity references resolved by the webhook handler. */
export interface ManualScheduleCustomerState {
  /** E.164 or raw — will be normalized here defensively. */
  customerPhone: string;
  pdPersonId?: number;
  pdDealId?: number;
  qbCustomerId?: string;
  qbEstimateId?: string;
  /** Fallback if classifier didn't produce a scope summary. */
  fallbackScopeSummary?: string;
}

export interface NormalizeManualScheduleInput {
  classification: ManualScheduleClassification;
  customer: ManualScheduleCustomerState;
}

/**
 * Deps subset — manual schedule needs no client calls, only id + clock.
 * Kept compatible with `NormalizerDeps` so the same bundle can be passed
 * through from the middleware handler.
 */
export type ManualScheduleDeps = Pick<NormalizerDeps, 'newId' | 'now'>;

export function normalizeManualSchedule(
  deps: ManualScheduleDeps,
  { classification, customer }: NormalizeManualScheduleInput,
): ManualScheduleDirective {
  const customerPhone = normalizePhone(customer.customerPhone) ?? customer.customerPhone;
  const eventClass: EventClass = classification.eventClass ?? 'job';
  const scopeSummary = classification.scopeSummary?.trim()
    || customer.fallbackScopeSummary?.trim()
    || '(scope to be confirmed)';

  const confidence = scoreConfidence({
    classifierScore: classification.score,
    hasKnownSlot: !!classification.knownSlot,
    hasPdMatch: customer.pdPersonId !== undefined,
    hasQbEstimate: customer.qbEstimateId !== undefined,
  });

  return {
    id: deps.newId(),
    createdAt: deps.now().toISOString(),
    source: 'quo_outbound',
    intent: 'manual_schedule',
    eventClass,
    confidence,
    customerPhone,
    pdPersonId: customer.pdPersonId,
    pdDealId: customer.pdDealId,
    qbCustomerId: customer.qbCustomerId,
    qbEstimateId: customer.qbEstimateId,
    scopeSummary,
    estimatedDurationHours: null,
    durationPrediction: null,
    ...(classification.knownSlot ? { knownSlot: classification.knownSlot } : {}),
  };
}

// ── helpers ───────────────────────────────────────────────────────

interface ScoreInputs {
  classifierScore: number;
  hasKnownSlot: boolean;
  hasPdMatch: boolean;
  hasQbEstimate: boolean;
}

/**
 * Manual-schedule confidence anchors on the classifier's score (this is
 * an LLM-extracted intent, so the classifier's confidence is the dominant
 * factor) and adds small boosts for corroborating signals.
 */
function scoreConfidence(inputs: ScoreInputs): Confidence {
  const signals: string[] = ['matt_outbound_intent'];
  let score = Math.max(0, Math.min(1, inputs.classifierScore)) * 0.7;

  if (inputs.hasKnownSlot) {
    signals.push('explicit_slot_extracted');
    score += 0.15;
  }
  if (inputs.hasPdMatch) {
    signals.push('matching_pd_person_found');
    score += 0.1;
  }
  if (inputs.hasQbEstimate) {
    signals.push('open_qb_estimate_for_customer');
    score += 0.05;
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), signals };
}
