import { describe, it, expect } from 'vitest';
import {
  normalizeQuoCustomerIntent,
  type NormalizeQuoCustomerInput,
  type QuoCustomerDeps,
} from '../src/normalize-quo-customer.js';

const deps: QuoCustomerDeps = {
  newId: () => '01HQTESTQUOCX',
  now: () => new Date('2026-05-30T12:00:00.000Z'),
};

function makeInput(
  overrides: Partial<NormalizeQuoCustomerInput> = {},
): NormalizeQuoCustomerInput {
  return {
    classification: {
      intent: 'quote_approved',
      score: 0.9,
      rationale: 'customer accepted quote',
      scopeSummary: '',
    },
    customer: {
      customerPhone: '+16175550123',
      pdPersonId: 9001,
      pdPersonName: 'John Smith',
    },
    source: 'quo_text',
    ...overrides,
  };
}

describe('normalizeQuoCustomerIntent', () => {
  it('produces a QuoteApprovedDirective from a customer-approved text', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput());
    expect(directive).not.toBeNull();
    expect(directive!.intent).toBe('quote_approved');
    expect(directive!.eventClass).toBe('job');
    expect(directive!.source).toBe('quo_text');
    expect(directive!.customerPhone).toBe('+16175550123');
    expect(directive!.pdPersonId).toBe(9001);
    expect(directive!.id).toBe('01HQTESTQUOCX');
    expect(directive!.estimatedDurationHours).toBeNull();
    expect(directive!.durationPrediction).toBeNull();
  });

  it('falls back to a customer-name scope when classifier provides none', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'quote_approved', score: 0.9, rationale: 'x', scopeSummary: '',
      },
    }));
    expect(directive!.scopeSummary).toBe('John Smith — (scope from inbound message)');
  });

  it('uses the classifier scope when present', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'assessment_requested',
        score: 0.8,
        rationale: 'site visit requested',
        scopeSummary: 'wet basement, NE corner',
      },
    }));
    expect(directive!.scopeSummary).toBe('wet basement, NE corner');
  });

  it('produces an AssessmentRequestedDirective with assessment eventClass', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'assessment_requested', score: 0.75, rationale: '', scopeSummary: '',
      },
    }));
    expect(directive!.intent).toBe('assessment_requested');
    expect(directive!.eventClass).toBe('assessment');
  });

  it('boosts quote_approved confidence when an open QB estimate is known', () => {
    const withEstimate = normalizeQuoCustomerIntent(deps, makeInput({
      customer: {
        customerPhone: '+16175550123',
        pdPersonId: 9001,
        pdPersonName: 'John Smith',
        qbEstimateId: '5001',
      },
    }));
    const withoutEstimate = normalizeQuoCustomerIntent(deps, makeInput());

    expect(withEstimate!.confidence.signals).toContain('open_qb_estimate_for_customer');
    expect(withoutEstimate!.confidence.signals).toContain('no_open_qb_estimate');
    expect(withEstimate!.confidence.score).toBeGreaterThan(withoutEstimate!.confidence.score);
  });

  it('produces a CallbackOpenedDirective when callbackParent is supplied', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'callback_opened',
        score: 0.85,
        rationale: 'prior fix leaking',
        scopeSummary: 'leak at prior repair',
      },
      callbackParent: {
        parentDealId: 12345,
        callbackSequence: 1,
        originalServiceType: 'crack injection',
      },
    }));
    expect(directive!.intent).toBe('callback_opened');
    expect(directive!.eventClass).toBe('callback');
    if (directive!.intent === 'callback_opened') {
      expect(directive!.parentDealId).toBe(12345);
      expect(directive!.callbackSequence).toBe(1);
      expect(directive!.originalServiceType).toBe('crack injection');
    }
    expect(directive!.confidence.signals).toContain('parent_deal_resolved_via_calendar');
    expect(directive!.confidence.signals).toContain('first_callback_on_parent');
  });

  it('encodes higher callback sequence in signals', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'callback_opened', score: 0.8, rationale: '', scopeSummary: '',
      },
      callbackParent: { parentDealId: 99, callbackSequence: 3 },
    }));
    expect(directive!.confidence.signals).toContain('callback_sequence_3');
    expect(directive!.confidence.signals).not.toContain('first_callback_on_parent');
  });

  it('returns null for callback_opened without callbackParent', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'callback_opened', score: 0.85, rationale: '', scopeSummary: '',
      },
    }));
    expect(directive).toBeNull();
  });

  it('omits originalServiceType when callback parent has none', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      classification: {
        intent: 'callback_opened', score: 0.8, rationale: '', scopeSummary: '',
      },
      callbackParent: { parentDealId: 7, callbackSequence: 1 },
    }));
    if (directive && directive.intent === 'callback_opened') {
      expect(directive.originalServiceType).toBeUndefined();
    }
  });

  it('re-normalizes phone defensively', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      customer: {
        customerPhone: '617-555-0123',
        pdPersonId: 1,
        pdPersonName: 'Test',
      },
    }));
    expect(directive!.customerPhone).toBe('+16175550123');
  });

  it('respects source=quo_call for call-transcript path', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      source: 'quo_call',
    }));
    expect(directive!.source).toBe('quo_call');
  });

  it('carries open PD deal id forward when present', () => {
    const directive = normalizeQuoCustomerIntent(deps, makeInput({
      customer: {
        customerPhone: '+16175550123',
        pdPersonId: 9001,
        pdPersonName: 'John Smith',
        pdDealId: 7001,
      },
    }));
    expect(directive!.pdDealId).toBe(7001);
    expect(directive!.confidence.signals).toContain('open_pd_deal');
  });
});
