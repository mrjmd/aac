import { describe, it, expect } from 'vitest';
import {
  normalizeAppointmentConfirmed,
  type AppointmentConfirmedDeps,
  type NormalizeAppointmentConfirmedInput,
} from '../src/normalize-appointment-confirmed.js';

const deps: AppointmentConfirmedDeps = {
  newId: () => '01HQCONF',
  now: () => new Date('2026-09-30T15:00:00.000Z'),
};

function makeInput(overrides: {
  classification?: Partial<NormalizeAppointmentConfirmedInput['classification']>;
  customer?: Partial<NormalizeAppointmentConfirmedInput['customer']>;
  source?: NormalizeAppointmentConfirmedInput['source'];
} = {}): NormalizeAppointmentConfirmedInput {
  return {
    classification: {
      score: 0.9,
      knownSlot: { startIso: '2026-10-05T15:30:00.000Z' },
      eventClass: 'assessment',
      scopeSummary: 'basement crack assessment',
      ...overrides.classification,
    },
    customer: {
      customerPhone: '+16175550123',
      pdPersonId: 9001,
      ...overrides.customer,
    },
    source: overrides.source ?? 'quo_text',
  };
}

describe('normalizeAppointmentConfirmed', () => {
  it('produces a well-formed AppointmentConfirmedDirective', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput());
    expect(d.intent).toBe('appointment_confirmed');
    expect(d.source).toBe('quo_text');
    expect(d.eventClass).toBe('assessment');
    expect(d.knownSlot).toEqual({ startIso: '2026-10-05T15:30:00.000Z' });
    expect(d.customerPhone).toBe('+16175550123');
    expect(d.pdPersonId).toBe(9001);
    expect(d.scopeSummary).toBe('basement crack assessment');
    expect(d.id).toBe('01HQCONF');
    expect(d.createdAt).toBe('2026-09-30T15:00:00.000Z');
    expect(d.estimatedDurationHours).toBeNull();
    expect(d.durationPrediction).toBeNull();
  });

  it('defaults eventClass to assessment when the classifier gave none', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput({
      classification: { eventClass: undefined },
    }));
    expect(d.eventClass).toBe('assessment');
  });

  it('carries quo_call source through', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput({ source: 'quo_call' }));
    expect(d.source).toBe('quo_call');
  });

  it('normalizes the customer phone', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput({
      customer: { customerPhone: '(617) 555-0123' },
    }));
    expect(d.customerPhone).toBe('+16175550123');
  });

  it('falls back to the provided scope summary, then to placeholder', () => {
    const withFallback = normalizeAppointmentConfirmed(deps, makeInput({
      classification: { scopeSummary: '' },
      customer: { fallbackScopeSummary: 'from PD notes' },
    }));
    expect(withFallback.scopeSummary).toBe('from PD notes');

    const placeholder = normalizeAppointmentConfirmed(deps, makeInput({
      classification: { scopeSummary: '' },
    }));
    expect(placeholder.scopeSummary).toBe('(scope to be confirmed)');
  });

  it('clears the 0.7 auto-threshold on classifier-high with a PD match', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput({
      classification: { score: 0.9 },
    }));
    // 0.9*0.7 + 0.15 + 0.1 = 0.88
    expect(d.confidence.score).toBeGreaterThanOrEqual(0.7);
    expect(d.confidence.signals).toContain('customer_confirmed_offered_slot');
    expect(d.confidence.signals).toContain('matching_pd_person_found');
  });

  it('stays below the auto-threshold on classifier-low', () => {
    const d = normalizeAppointmentConfirmed(deps, makeInput({
      classification: { score: 0.5 },
      customer: { pdPersonId: undefined },
    }));
    // 0.5*0.7 + 0.15 = 0.5
    expect(d.confidence.score).toBeLessThan(0.7);
  });
});
