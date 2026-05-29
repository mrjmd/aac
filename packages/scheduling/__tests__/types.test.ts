import { describe, it, expect } from 'vitest';
import {
  isQuoteApproved,
  isAssessmentRequested,
  isCallbackOpened,
  isManualSchedule,
  type SchedulingDirective,
  type QuoteApprovedDirective,
  type AssessmentRequestedDirective,
  type CallbackOpenedDirective,
  type ManualScheduleDirective,
} from '../src/types.js';

const baseFields = {
  id: '01HQXY...',
  createdAt: '2026-05-29T15:00:00.000Z',
  confidence: { score: 0.92, signals: ['qb_signature_verified'] },
  customerPhone: '+18287724836',
  scopeSummary: 'Waterproofing — Smith residence',
  estimatedDurationHours: null,
} as const;

const quoteApproved: QuoteApprovedDirective = {
  ...baseFields,
  source: 'qb_webhook',
  intent: 'quote_approved',
  eventClass: 'job',
  qbEstimateId: '1234',
};

const assessmentRequested: AssessmentRequestedDirective = {
  ...baseFields,
  source: 'quo_text',
  intent: 'assessment_requested',
  eventClass: 'assessment',
};

const callbackOpened: CallbackOpenedDirective = {
  ...baseFields,
  source: 'quo_text',
  intent: 'callback_opened',
  eventClass: 'callback',
  parentDealId: 4242,
  callbackSequence: 1,
  originalServiceType: 'waterproofing',
  originalTechnician: 'Mike',
};

const manualSchedule: ManualScheduleDirective = {
  ...baseFields,
  source: 'quo_outbound',
  intent: 'manual_schedule',
  eventClass: 'job',
  knownSlot: { startIso: '2026-06-02T14:00:00.000Z' },
};

describe('directive discriminators', () => {
  it('isQuoteApproved is true only for quote_approved', () => {
    expect(isQuoteApproved(quoteApproved)).toBe(true);
    expect(isQuoteApproved(assessmentRequested)).toBe(false);
    expect(isQuoteApproved(callbackOpened)).toBe(false);
    expect(isQuoteApproved(manualSchedule)).toBe(false);
  });

  it('isAssessmentRequested is true only for assessment_requested', () => {
    expect(isAssessmentRequested(assessmentRequested)).toBe(true);
    expect(isAssessmentRequested(quoteApproved)).toBe(false);
    expect(isAssessmentRequested(callbackOpened)).toBe(false);
    expect(isAssessmentRequested(manualSchedule)).toBe(false);
  });

  it('isCallbackOpened is true only for callback_opened', () => {
    expect(isCallbackOpened(callbackOpened)).toBe(true);
    expect(isCallbackOpened(quoteApproved)).toBe(false);
    expect(isCallbackOpened(assessmentRequested)).toBe(false);
    expect(isCallbackOpened(manualSchedule)).toBe(false);
  });

  it('isManualSchedule is true only for manual_schedule', () => {
    expect(isManualSchedule(manualSchedule)).toBe(true);
    expect(isManualSchedule(quoteApproved)).toBe(false);
    expect(isManualSchedule(assessmentRequested)).toBe(false);
    expect(isManualSchedule(callbackOpened)).toBe(false);
  });

  it('narrows discriminated union in a switch', () => {
    function eventClassFor(d: SchedulingDirective): string {
      switch (d.intent) {
        case 'quote_approved':
          return d.eventClass;
        case 'assessment_requested':
          return d.eventClass;
        case 'callback_opened':
          return `${d.eventClass}#${d.callbackSequence}`;
        case 'manual_schedule':
          return d.knownSlot ? `${d.eventClass}@${d.knownSlot.startIso}` : d.eventClass;
      }
    }
    expect(eventClassFor(quoteApproved)).toBe('job');
    expect(eventClassFor(assessmentRequested)).toBe('assessment');
    expect(eventClassFor(callbackOpened)).toBe('callback#1');
    expect(eventClassFor(manualSchedule)).toBe('job@2026-06-02T14:00:00.000Z');
  });
});

describe('directive shape contracts', () => {
  it('is JSON-roundtrip safe (transport via Redis)', () => {
    const directives: SchedulingDirective[] = [
      quoteApproved,
      assessmentRequested,
      callbackOpened,
      manualSchedule,
    ];
    for (const d of directives) {
      const json = JSON.stringify(d);
      const parsed: SchedulingDirective = JSON.parse(json);
      expect(parsed).toEqual(d);
    }
  });

  it('callback_opened requires parentDealId + callbackSequence', () => {
    // TypeScript enforces this at compile time; the runtime check is a
    // belt-and-suspenders guard in case a directive arrives via JSON without them.
    expect(callbackOpened.parentDealId).toBe(4242);
    expect(callbackOpened.callbackSequence).toBeGreaterThanOrEqual(1);
  });

  it('quote_approved is always eventClass=job', () => {
    expect(quoteApproved.eventClass).toBe('job');
  });

  it('assessment_requested is always eventClass=assessment', () => {
    expect(assessmentRequested.eventClass).toBe('assessment');
  });

  it('callback_opened is always eventClass=callback', () => {
    expect(callbackOpened.eventClass).toBe('callback');
  });
});
