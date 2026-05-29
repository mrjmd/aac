import { describe, it, expect } from 'vitest';
import {
  normalizeManualSchedule,
  type ManualScheduleDeps,
  type NormalizeManualScheduleInput,
} from '../src/normalize-manual-schedule.js';

const deps: ManualScheduleDeps = {
  newId: () => '01HQTEST',
  now: () => new Date('2026-05-29T15:00:00.000Z'),
};

function makeInput(overrides: {
  classification?: Partial<NormalizeManualScheduleInput['classification']>;
  customer?: Partial<NormalizeManualScheduleInput['customer']>;
} = {}): NormalizeManualScheduleInput {
  return {
    classification: {
      score: 0.85,
      eventClass: 'job',
      scopeSummary: 'Smith waterproof — confirmed Tue 10am',
      ...overrides.classification,
    },
    customer: {
      customerPhone: '+16175550123',
      pdPersonId: 9001,
      qbEstimateId: '1234',
      ...overrides.customer,
    },
  };
}

describe('normalizeManualSchedule', () => {
  it('produces a well-formed ManualScheduleDirective', () => {
    const directive = normalizeManualSchedule(deps, makeInput());
    expect(directive.intent).toBe('manual_schedule');
    expect(directive.source).toBe('quo_outbound');
    expect(directive.eventClass).toBe('job');
    expect(directive.customerPhone).toBe('+16175550123');
    expect(directive.pdPersonId).toBe(9001);
    expect(directive.qbEstimateId).toBe('1234');
    expect(directive.scopeSummary).toBe('Smith waterproof — confirmed Tue 10am');
    expect(directive.id).toBe('01HQTEST');
    expect(directive.createdAt).toBe('2026-05-29T15:00:00.000Z');
    expect(directive.estimatedDurationHours).toBeNull();
  });

  it('includes knownSlot when classifier extracted one', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.9, knownSlot: { startIso: '2026-06-02T14:00:00.000Z' } },
    }));
    expect(directive.knownSlot).toEqual({ startIso: '2026-06-02T14:00:00.000Z' });
    expect(directive.confidence.signals).toContain('explicit_slot_extracted');
  });

  it('omits knownSlot when classifier did not extract one', () => {
    const directive = normalizeManualSchedule(deps, makeInput());
    expect(directive.knownSlot).toBeUndefined();
    expect(directive.confidence.signals).not.toContain('explicit_slot_extracted');
  });

  it('defaults eventClass to job when classifier did not infer', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.7, eventClass: undefined },
    }));
    expect(directive.eventClass).toBe('job');
  });

  it('respects eventClass=callback or assessment when classifier set it', () => {
    const callback = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.7, eventClass: 'callback' },
    }));
    expect(callback.eventClass).toBe('callback');

    const assessment = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.7, eventClass: 'assessment' },
    }));
    expect(assessment.eventClass).toBe('assessment');
  });

  it('normalizes a raw US phone number to E.164', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      customer: { customerPhone: '(617) 555-0123' },
    }));
    expect(directive.customerPhone).toBe('+16175550123');
  });

  it('falls back to customer scope summary when classifier produced none', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.7, scopeSummary: undefined },
      customer: { customerPhone: '+16175550123', fallbackScopeSummary: 'Smith — waterproof' },
    }));
    expect(directive.scopeSummary).toBe('Smith — waterproof');
  });

  it('falls back to placeholder when no scope info at all', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.7, scopeSummary: undefined },
      customer: { customerPhone: '+16175550123' },
    }));
    expect(directive.scopeSummary).toBe('(scope to be confirmed)');
  });

  it('confidence scales with classifier score', () => {
    const low = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.3 },
    }));
    const high = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.95 },
    }));
    expect(high.confidence.score).toBeGreaterThan(low.confidence.score);
  });

  it('confidence is bounded to [0, 1]', () => {
    const maxxed = normalizeManualSchedule(deps, makeInput({
      classification: {
        score: 1,
        knownSlot: { startIso: '2026-06-02T14:00:00.000Z' },
      },
    }));
    expect(maxxed.confidence.score).toBeLessThanOrEqual(1);

    const zero = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0 },
      customer: { customerPhone: '+16175550123' },
    }));
    expect(zero.confidence.score).toBeGreaterThanOrEqual(0);
  });

  it('omits pd/qb references when not present', () => {
    const directive = normalizeManualSchedule(deps, {
      classification: { score: 0.7 },
      customer: { customerPhone: '+16175550123' },
    });
    expect(directive.pdPersonId).toBeUndefined();
    expect(directive.qbEstimateId).toBeUndefined();
    expect(directive.confidence.signals).not.toContain('matching_pd_person_found');
    expect(directive.confidence.signals).not.toContain('open_qb_estimate_for_customer');
  });

  it('directive is JSON-roundtrip safe', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      classification: { score: 0.9, knownSlot: { startIso: '2026-06-02T14:00:00.000Z' } },
    }));
    expect(JSON.parse(JSON.stringify(directive))).toEqual(directive);
  });

  it('keeps raw phone unchanged when normalization fails', () => {
    const directive = normalizeManualSchedule(deps, makeInput({
      customer: { customerPhone: 'not-a-phone' },
    }));
    expect(directive.customerPhone).toBe('not-a-phone');
  });
});
