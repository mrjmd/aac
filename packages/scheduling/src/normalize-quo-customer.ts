/**
 * normalizeQuoCustomerIntent — turn a customer-side classifier output
 * into a directive of the matching intent.
 *
 * The Quo webhook upstream:
 *   1. Resolves the customer (PD person, phone) — passes via `customer`
 *   2. Runs the Gemini classifier — passes via `classification`
 *   3. For callback_opened: resolves parent deal via `resolveCallbackParent`
 *      and passes via `callbackParent`
 *
 * This function is pure: no client calls, no I/O. All resolved state
 * arrives via inputs. Matches the contract of `normalizeManualSchedule`.
 *
 * Returns null when:
 *   - intent is `callback_opened` but `callbackParent` is undefined
 *     (caller couldn't resolve the parent — no directive can form)
 *
 * Confidence scoring anchors on the classifier's score (LLM-derived) and
 * adds small boosts for corroborating signals: PD match, QB estimate
 * for quote_approved, callback parent resolved with marker.
 */

import { normalizePhone } from '@aac/shared-utils/phone';
import type {
  AssessmentRequestedDirective,
  CallbackOpenedDirective,
  Confidence,
  NormalizerDeps,
  QuoteApprovedDirective,
} from './types.js';

export type QuoCustomerIntentLabel =
  | 'quote_approved'
  | 'assessment_requested'
  | 'callback_opened';

/** What the Gemini classifier extracted from the customer message. */
export interface QuoCustomerClassification {
  intent: QuoCustomerIntentLabel;
  /** Numeric score in [0, 1]. From `classifySchedulingIntent.score`. */
  score: number;
  /** Brief evidence string for traceability. */
  rationale: string;
  /** Short scope hint from the classifier (may be empty). */
  scopeSummary: string;
}

/** Customer + entity references resolved by the webhook handler. */
export interface QuoCustomerState {
  /** E.164 (defensively re-normalized here). */
  customerPhone: string;
  pdPersonId: number;
  /** Customer's PD display name — used in fallback scope summary. */
  pdPersonName: string;
  /** Open PD deal if known. Helpful but not required. */
  pdDealId?: number;
  qbCustomerId?: string;
  /** Open QB estimate id, if the webhook resolved one. */
  qbEstimateId?: string;
}

/** Resolved callback parent info (from `resolveCallbackParent`). */
export interface QuoCallbackParent {
  parentDealId: number;
  callbackSequence: number;
  originalServiceType?: string;
  originalTechnician?: string;
}

export type QuoCustomerSource = 'quo_text' | 'quo_call';

export interface NormalizeQuoCustomerInput {
  classification: QuoCustomerClassification;
  customer: QuoCustomerState;
  source: QuoCustomerSource;
  /** Required when intent === 'callback_opened'. */
  callbackParent?: QuoCallbackParent;
}

export type QuoCustomerDirective =
  | QuoteApprovedDirective
  | AssessmentRequestedDirective
  | CallbackOpenedDirective;

export type QuoCustomerDeps = Pick<NormalizerDeps, 'newId' | 'now'>;

export function normalizeQuoCustomerIntent(
  deps: QuoCustomerDeps,
  { classification, customer, source, callbackParent }: NormalizeQuoCustomerInput,
): QuoCustomerDirective | null {
  if (classification.intent === 'callback_opened' && !callbackParent) {
    return null;
  }

  const customerPhone = normalizePhone(customer.customerPhone) ?? customer.customerPhone;
  const scopeSummary = classification.scopeSummary.trim()
    || `${customer.pdPersonName} — (scope from inbound message)`;

  const base = {
    id: deps.newId(),
    createdAt: deps.now().toISOString(),
    source,
    customerPhone,
    pdPersonId: customer.pdPersonId,
    pdDealId: customer.pdDealId,
    qbCustomerId: customer.qbCustomerId,
    qbEstimateId: customer.qbEstimateId,
    scopeSummary,
    estimatedDurationHours: null,
    durationPrediction: null,
  };

  switch (classification.intent) {
    case 'quote_approved':
      return {
        ...base,
        intent: 'quote_approved',
        eventClass: 'job',
        confidence: scoreQuoteApproved(classification.score, customer),
      };

    case 'assessment_requested':
      return {
        ...base,
        intent: 'assessment_requested',
        eventClass: 'assessment',
        confidence: scoreAssessment(classification.score, customer),
      };

    case 'callback_opened':
      // Narrowed by guard above.
      return {
        ...base,
        intent: 'callback_opened',
        eventClass: 'callback',
        confidence: scoreCallback(classification.score, customer, callbackParent!),
        parentDealId: callbackParent!.parentDealId,
        callbackSequence: callbackParent!.callbackSequence,
        ...(callbackParent!.originalServiceType
          ? { originalServiceType: callbackParent!.originalServiceType }
          : {}),
        ...(callbackParent!.originalTechnician
          ? { originalTechnician: callbackParent!.originalTechnician }
          : {}),
      };
  }
}

// ── confidence scorers ────────────────────────────────────────────

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

function scoreQuoteApproved(
  classifierScore: number,
  customer: QuoCustomerState,
): Confidence {
  const signals: string[] = ['customer_intent_classified'];
  let score = Math.max(0, Math.min(1, classifierScore)) * 0.65;

  if (customer.pdPersonId) {
    signals.push('pd_person_matched');
    score += 0.1;
  }
  if (customer.qbEstimateId) {
    signals.push('open_qb_estimate_for_customer');
    score += 0.2;
  } else {
    signals.push('no_open_qb_estimate');
  }
  if (customer.pdDealId) {
    signals.push('open_pd_deal');
    score += 0.05;
  }
  return { score: clamp(score), signals };
}

function scoreAssessment(
  classifierScore: number,
  customer: QuoCustomerState,
): Confidence {
  const signals: string[] = ['customer_intent_classified'];
  let score = Math.max(0, Math.min(1, classifierScore)) * 0.75;

  if (customer.pdPersonId) {
    signals.push('pd_person_matched');
    score += 0.1;
  }
  return { score: clamp(score), signals };
}

function scoreCallback(
  classifierScore: number,
  customer: QuoCustomerState,
  parent: QuoCallbackParent,
): Confidence {
  const signals: string[] = [
    'customer_intent_classified',
    'parent_deal_resolved_via_calendar',
  ];
  let score = Math.max(0, Math.min(1, classifierScore)) * 0.6;

  score += 0.2; // parent resolution is a strong signal

  if (parent.originalServiceType) {
    signals.push('parent_service_type_known');
    score += 0.05;
  }
  if (customer.pdPersonId) {
    signals.push('pd_person_matched');
    score += 0.1;
  }
  if (parent.callbackSequence === 1) {
    signals.push('first_callback_on_parent');
  } else {
    signals.push(`callback_sequence_${parent.callbackSequence}`);
  }
  return { score: clamp(score), signals };
}
