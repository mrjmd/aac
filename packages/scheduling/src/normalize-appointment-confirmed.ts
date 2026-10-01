/**
 * normalizeAppointmentConfirmed — turn a customer's "yes, that time works"
 * into an AppointmentConfirmedDirective.
 *
 * Fires when the middleware's Gemini classifier (running with conversation
 * context) detects a customer agreeing to a specific slot Matt previously
 * offered. The classifier resolves the slot from the antecedent messages;
 * this normalizer just packages it with customer references.
 *
 * Pure function. No I/O. Mirrors normalize-manual-schedule.
 */

import { normalizePhone } from '@aac/shared-utils/phone';
import type {
  AppointmentConfirmedDirective,
  Confidence,
  EventClass,
  KnownSlot,
  NormalizerDeps,
} from './types.js';

/** What the Gemini classifier extracted from the customer's confirmation. */
export interface AppointmentConfirmedClassification {
  /** Score from the classifier in [0, 1]. */
  score: number;
  /** The slot the customer agreed to — required for this intent. */
  knownSlot: KnownSlot;
  /** Event class inferred from the offered visit — defaults to 'assessment'. */
  eventClass?: EventClass;
  /** LLM scope summary, or '' if the classifier produced none. */
  scopeSummary?: string;
}

/** Customer + entity references resolved by the webhook handler. */
export interface AppointmentConfirmedCustomerState {
  /** E.164 or raw — will be normalized here defensively. */
  customerPhone: string;
  pdPersonId?: number;
  pdDealId?: number;
  qbCustomerId?: string;
  qbEstimateId?: string;
  /** Fallback if classifier didn't produce a scope summary. */
  fallbackScopeSummary?: string;
}

export interface NormalizeAppointmentConfirmedInput {
  classification: AppointmentConfirmedClassification;
  customer: AppointmentConfirmedCustomerState;
  source: 'quo_text' | 'quo_call';
}

/** Deps subset — no client calls, only id + clock. */
export type AppointmentConfirmedDeps = Pick<NormalizerDeps, 'newId' | 'now'>;

export function normalizeAppointmentConfirmed(
  deps: AppointmentConfirmedDeps,
  { classification, customer, source }: NormalizeAppointmentConfirmedInput,
): AppointmentConfirmedDirective {
  const customerPhone = normalizePhone(customer.customerPhone) ?? customer.customerPhone;
  // A confirmation without an offered quote in play is most often accepting
  // an assessment visit; job confirmations normally arrive via quote_approved.
  const eventClass: EventClass = classification.eventClass ?? 'assessment';
  const scopeSummary = classification.scopeSummary?.trim()
    || customer.fallbackScopeSummary?.trim()
    || '(scope to be confirmed)';

  const confidence = scoreConfidence({
    classifierScore: classification.score,
    hasPdMatch: customer.pdPersonId !== undefined,
    hasQbEstimate: customer.qbEstimateId !== undefined,
  });

  return {
    id: deps.newId(),
    createdAt: deps.now().toISOString(),
    source,
    intent: 'appointment_confirmed',
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
    knownSlot: classification.knownSlot,
  };
}

// ── helpers ───────────────────────────────────────────────────────

interface ScoreInputs {
  classifierScore: number;
  hasPdMatch: boolean;
  hasQbEstimate: boolean;
}

/**
 * Same shape as manual-schedule scoring: the classifier's confidence
 * dominates (this is an LLM-resolved agreement + slot), with small boosts
 * for corroborating references. The slot itself is required for this
 * intent, so its boost is unconditional — a classifier-high confirmation
 * with a PD match clears the 0.7 auto-threshold; classifier-low never does.
 */
function scoreConfidence(inputs: ScoreInputs): Confidence {
  const signals: string[] = ['customer_confirmed_offered_slot', 'explicit_slot_extracted'];
  let score = Math.max(0, Math.min(1, inputs.classifierScore)) * 0.7 + 0.15;

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
