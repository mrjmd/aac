import { describe, it, expect } from 'vitest';
import type { ProposalPayload } from '@aac/scheduling';
import { formatProposalSms } from '../lib/proposals.js';

function makePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    proposalId: 'prop_1',
    directive: {
      id: 'dir_1',
      intent: 'quote_approved',
      eventClass: 'job',
      customerName: 'John Smith',
      customerPhone: '+16175550123',
      scopeSummary: 'John Smith — crack injection on rear wall',
    },
    slot: {
      startIso: '2026-06-02T13:00:00.000Z', // 9am ET (EDT)
      endIso: '2026-06-02T17:00:00.000Z',   // 1pm ET
      reasoning: 'next available weekday under soft cap',
    },
    eventDescription: 'Scope:\n- crack injection',
    descriptionUsedFallback: false,
    createdAt: '2026-05-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('formatProposalSms', () => {
  it('includes the customer, intent label, scope, and reasoning', () => {
    const sms = formatProposalSms(makePayload());
    expect(sms).toContain('John Smith');
    expect(sms).toContain('job');
    expect(sms).toContain('crack injection on rear wall');
    expect(sms).toContain('next available weekday under soft cap');
    expect(sms).toContain('Reply YES to confirm');
  });

  it('strips the customer-name prefix from the scope line', () => {
    const sms = formatProposalSms(makePayload());
    // Header line has the customer; scope line should NOT repeat "John Smith — "
    const lines = sms.split('\n');
    expect(lines[1]).toBe('crack injection on rear wall');
  });

  it('formats the day line in America/New_York with weekday + duration', () => {
    const sms = formatProposalSms(makePayload());
    // 2026-06-02 is Tuesday; 13:00 UTC → 9am EDT, 17:00 UTC → 1pm EDT
    expect(sms).toContain('Tue Jun 2');
    expect(sms).toContain('9am–1pm');
    expect(sms).toContain('(4h)');
  });

  it('labels assessment intent', () => {
    const sms = formatProposalSms(makePayload({
      directive: {
        id: 'dir_1',
        intent: 'assessment_requested',
        eventClass: 'assessment',
        customerName: 'Jane Doe',
        customerPhone: '+16175550124',
        scopeSummary: 'wet basement NE corner',
      },
    }));
    expect(sms).toContain('Jane Doe — assessment');
    expect(sms).toContain('wet basement NE corner');
  });

  it('labels callback intent', () => {
    const sms = formatProposalSms(makePayload({
      directive: {
        id: 'dir_1',
        intent: 'callback_opened',
        eventClass: 'callback',
        customerName: 'Bob',
        customerPhone: '+16175550125',
        scopeSummary: 'leak at previous patch',
      },
    }));
    expect(sms).toContain('Bob — callback');
  });

  it('adds a template-fallback badge when description used fallback', () => {
    const sms = formatProposalSms(makePayload({ descriptionUsedFallback: true }));
    expect(sms).toContain('(description: template fallback)');
  });

  it('clamps long scope and reasoning', () => {
    const longScope = 'A'.repeat(200);
    const longReason = 'B'.repeat(200);
    const sms = formatProposalSms(makePayload({
      directive: {
        id: 'dir_1',
        intent: 'quote_approved',
        eventClass: 'job',
        customerName: 'Long',
        customerPhone: '+16175550199',
        scopeSummary: longScope,
      },
      slot: {
        startIso: '2026-06-02T13:00:00.000Z',
        endIso: '2026-06-02T17:00:00.000Z',
        reasoning: longReason,
      },
    }));
    const lines = sms.split('\n');
    // Scope line ends with ellipsis, doesn't exceed 90 chars
    expect(lines[1].length).toBeLessThanOrEqual(90);
    expect(lines[1].endsWith('…')).toBe(true);
    // Reasoning ellipsised too (4th line is `why: ...`)
    expect(sms).toMatch(/why:.*…/);
  });

  it('handles a non-integer-hour slot duration', () => {
    const sms = formatProposalSms(makePayload({
      slot: {
        startIso: '2026-06-02T13:00:00.000Z',
        endIso: '2026-06-02T14:30:00.000Z',
        reasoning: 'half-hour test',
      },
    }));
    expect(sms).toContain('9am–10:30am');
    expect(sms).toContain('(1.5h)');
  });

  it('falls back to (no scope on file) when scope is empty', () => {
    const sms = formatProposalSms(makePayload({
      directive: {
        id: 'dir_1',
        intent: 'quote_approved',
        eventClass: 'job',
        customerName: 'Empty',
        customerPhone: '+16175550199',
        scopeSummary: '',
      },
    }));
    const lines = sms.split('\n');
    expect(lines[1]).toBe('(no scope on file)');
  });
});
