/**
 * normalizeQbApproval — turn a QB Estimate.Update event into a
 * QuoteApprovedDirective.
 *
 * Called from `apps/middleware/api/qb-webhook` after the CloudEvents
 * envelope is verified and the full Estimate has been fetched. Returns
 * `null` if the estimate is not in an Accepted state — the webhook handler
 * can call this blindly without pre-filtering by status.
 *
 * Pure function. All side-effecting deps (PD/QB/Quo clients, id+clock)
 * arrive via `NormalizerDeps`.
 */

import { normalizePhone } from '@aac/shared-utils/phone';
import { estimateDuration } from '@aac/quoting';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import type {
  NormalizerDeps,
  QuoteApprovedDirective,
  Confidence,
} from './types.js';

export interface NormalizeQbApprovalInput {
  estimate: QBEstimate;
  /** Source defaults to qb_webhook; reconciliation cron overrides. */
  source?: 'qb_webhook' | 'qb_reconciliation';
}

export async function normalizeQbApproval(
  deps: NormalizerDeps,
  { estimate, source = 'qb_webhook' }: NormalizeQbApprovalInput,
): Promise<QuoteApprovedDirective | null> {
  if (estimate.TxnStatus !== 'Accepted') return null;

  const qbCustomerId = estimate.CustomerRef.value;
  const qbCustomer = await deps.qb.getCustomer(qbCustomerId);

  const rawPhone = qbCustomer?.PrimaryPhone?.FreeFormNumber ?? null;
  const customerPhone = normalizePhone(rawPhone) ?? '';

  const pdPerson = customerPhone
    ? await deps.pd.searchPersonByPhone(customerPhone)
    : null;

  const scopeSummary = buildScopeSummary(estimate);
  const durationPrediction = estimateDuration(estimate);
  const confidence = scoreConfidence({
    hasCustomerPhone: !!customerPhone,
    hasPdMatch: !!pdPerson,
    hasScope: scopeSummary.length > 0,
    source,
  });

  return {
    id: deps.newId(),
    createdAt: deps.now().toISOString(),
    source,
    intent: 'quote_approved',
    eventClass: 'job',
    confidence,
    customerPhone,
    pdPersonId: pdPerson?.id,
    qbCustomerId,
    qbEstimateId: estimate.Id,
    scopeSummary,
    estimatedDurationHours: durationPrediction.point,
    durationPrediction,
  };
}

// ── helpers ───────────────────────────────────────────────────────

function buildScopeSummary(estimate: QBEstimate): string {
  const customerName = estimate.CustomerRef.name ?? 'Customer';
  const lines = estimate.Line
    .map((l) => l.Description?.trim())
    .filter((d): d is string => !!d && d.length > 0);
  if (lines.length === 0) return `${customerName} — (no line-item descriptions)`;
  return `${customerName} — ${lines.join('; ')}`;
}

interface ScoreInputs {
  hasCustomerPhone: boolean;
  hasPdMatch: boolean;
  hasScope: boolean;
  source: 'qb_webhook' | 'qb_reconciliation';
}

/**
 * Confidence is built from independent signals. Webhook events are
 * inherently higher-confidence than reconciliation hits (the reconciliation
 * cron fires when we *didn't* receive a webhook — so something already
 * went wrong).
 */
function scoreConfidence(inputs: ScoreInputs): Confidence {
  const signals: string[] = ['qb_estimate_status_accepted'];
  let score = 0.5;

  if (inputs.source === 'qb_webhook') {
    signals.push('qb_webhook_signature_verified');
    score += 0.2;
  } else {
    signals.push('qb_reconciliation_backstop');
    // Backstop hits are inherently lower-confidence: webhook missed,
    // we found it via daily scan. Don't add to score.
  }
  if (inputs.hasCustomerPhone) {
    signals.push('customer_phone_normalized');
    score += 0.15;
  }
  if (inputs.hasPdMatch) {
    signals.push('matching_pd_person_found');
    score += 0.1;
  }
  if (inputs.hasScope) {
    signals.push('scope_summary_non_empty');
    score += 0.05;
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), signals };
}
