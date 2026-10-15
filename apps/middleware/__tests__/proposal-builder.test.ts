import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuoteApprovedDirective } from '@aac/scheduling';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const { mockGetPendingDirective, mockLogHealthError } = vi.hoisted(() => ({
  mockGetPendingDirective: vi.fn(),
  mockLogHealthError: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  getPendingDirective: mockGetPendingDirective,
  logHealthError: mockLogHealthError,
}));

import { buildProposalForDirective, selectBusyEvents, type ProposalBuilderDeps } from '../lib/proposal-builder.js';

function makeDirective(over: Partial<QuoteApprovedDirective> = {}): QuoteApprovedDirective {
  return {
    id: 'dir_1',
    createdAt: '2026-05-30T11:00:00.000Z',
    source: 'qb_webhook',
    intent: 'quote_approved',
    eventClass: 'job',
    confidence: { score: 0.9, signals: [] },
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    qbCustomerId: 'qb-1',
    qbEstimateId: 'qb-est-1',
    scopeSummary: 'John Smith — crack injection rear wall',
    estimatedDurationHours: 4,
    durationPrediction: {
      point: 4,
      p25: 3,
      p75: 5,
      cv: 0.26,
      confidence: 'high',
      rationale: 'cluster',
      similarCases: [],
      isMultiDay: false,
    },
    ...over,
  };
}

function makeDeps(over: Partial<ProposalBuilderDeps> = {}): ProposalBuilderDeps {
  const base: ProposalBuilderDeps = {
    pd: {
      getPerson: vi.fn().mockResolvedValue({
        id: 9001,
        name: 'John Smith',
        phone: [{ value: '+16175550123', primary: true }],
        email: [],
      }),
    } as unknown as ProposalBuilderDeps['pd'],
    qb: {
      getEstimate: vi.fn().mockResolvedValue({
        Id: 'qb-est-1',
        Line: [
          { Description: 'Urethane crack injection 8ft rear wall', Amount: 1200, DetailType: 'SalesItemLineDetail' },
          { Description: 'Carbon fiber staple add-on (qty 2)', Amount: 400, DetailType: 'SalesItemLineDetail' },
        ],
      }),
      getCustomer: vi.fn().mockResolvedValue({
        Id: 'qb-1',
        DisplayName: 'John Smith',
        BillAddr: {
          Line1: '42 Beacon St',
          City: 'Boston',
          CountrySubDivisionCode: 'MA',
          PostalCode: '02108',
        },
      }),
    } as unknown as ProposalBuilderDeps['qb'],
    quo: {
      getRecentActivityForContact: vi.fn().mockResolvedValue({
        messages: [
          { direction: 'incoming', text: 'gate code is 1234, dog is friendly', createdAt: '2026-05-29T14:00:00Z' },
          { direction: 'outgoing', text: 'thanks, noted', createdAt: '2026-05-29T14:05:00Z' },
        ],
        calls: [],
      }),
    } as unknown as ProposalBuilderDeps['quo'],
    calendar: {
      listEvents: vi.fn().mockResolvedValue([]),
    } as unknown as ProposalBuilderDeps['calendar'],
    gemini: {
      generateContent: vi.fn().mockResolvedValue(
        'Scope:\n- Urethane crack injection 8ft rear wall\n\nAddress:\n42 Beacon St, Boston MA 02108',
      ),
    } as unknown as ProposalBuilderDeps['gemini'],
    newProposalId: () => 'prop_test',
    now: () => new Date('2026-05-30T12:00:00.000Z'),
  };
  return { ...base, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildProposalForDirective', () => {
  it('returns null when the directive id is not in the shadow queue', async () => {
    mockGetPendingDirective.mockResolvedValueOnce(null);
    const result = await buildProposalForDirective(makeDeps(), 'unknown');
    expect(result).toBeNull();
  });

  it('builds a complete proposal with slot + description for a happy-path directive', async () => {
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    const result = await buildProposalForDirective(makeDeps(), 'dir_1');
    expect(result).not.toBeNull();
    expect(result!.payload.proposalId).toBe('prop_test');
    expect(result!.payload.directive.customerName).toBe('John Smith');
    expect(result!.payload.directive.intent).toBe('quote_approved');
    expect(result!.payload.slot.startIso).not.toBe('');
    expect(result!.payload.slot.endIso).not.toBe('');
    expect(result!.payload.eventDescription).toContain('42 Beacon');
    expect(result!.payload.eventDescription).toContain('Urethane');
    expect(result!.suggestedSlotFound).toBe(true);
    expect(result!.descriptionUsedFallback).toBe(false);
  });

  it('falls back gracefully when PD person lookup throws (name from scope)', async () => {
    const baseDeps = makeDeps();
    const deps: ProposalBuilderDeps = {
      ...baseDeps,
      pd: {
        getPerson: vi.fn().mockRejectedValue(new Error('pd 500')),
      } as unknown as ProposalBuilderDeps['pd'],
    };
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    const result = await buildProposalForDirective(deps, 'dir_1');
    expect(result).not.toBeNull();
    expect(result!.payload.directive.customerName).toBe('John Smith');
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('falls back gracefully when QB line item fetch throws', async () => {
    const baseDeps = makeDeps();
    const deps: ProposalBuilderDeps = {
      ...baseDeps,
      qb: {
        getEstimate: vi.fn().mockRejectedValue(new Error('qb estimate 500')),
        getCustomer: baseDeps.qb.getCustomer,
      } as unknown as ProposalBuilderDeps['qb'],
    };
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    const result = await buildProposalForDirective(deps, 'dir_1');
    expect(result).not.toBeNull();
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('proceeds with empty conversation when Quo fetch throws', async () => {
    const deps = makeDeps({
      quo: {
        getRecentActivityForContact: vi.fn().mockRejectedValue(new Error('quo 500')),
      } as unknown as ProposalBuilderDeps['quo'],
    });
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    const result = await buildProposalForDirective(deps, 'dir_1');
    expect(result).not.toBeNull();
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('proceeds when Calendar.listEvents throws (suggestSlot called with empty events)', async () => {
    const deps = makeDeps({
      calendar: {
        listEvents: vi.fn().mockRejectedValue(new Error('cal 500')),
      } as unknown as ProposalBuilderDeps['calendar'],
    });
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    const result = await buildProposalForDirective(deps, 'dir_1');
    expect(result).not.toBeNull();
    expect(result!.suggestedSlotFound).toBe(true);
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('skips QB estimate fetch when directive has no qbEstimateId', async () => {
    const deps = makeDeps();
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective({ qbEstimateId: undefined }));
    await buildProposalForDirective(deps, 'dir_1');
    expect(deps.qb.getEstimate).not.toHaveBeenCalled();
  });

  it('skips PD lookup when directive has no pdPersonId; uses scope-derived name', async () => {
    const deps = makeDeps();
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective({ pdPersonId: undefined }));
    const result = await buildProposalForDirective(deps, 'dir_1');
    expect(result).not.toBeNull();
    expect(deps.pd.getPerson).not.toHaveBeenCalled();
    expect(result!.payload.directive.customerName).toBe('John Smith');
  });

  it('fetches the calendar unfiltered and selects busy events locally (Mike events + holds)', async () => {
    const deps = makeDeps({
      technicianEmails: ['mike@attackacrack.com', 'harrringtonm@gmail.com'],
    });
    mockGetPendingDirective.mockResolvedValueOnce(makeDirective());
    await buildProposalForDirective(deps, 'dir_1');
    const callArg = (deps.calendar.listEvents as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    }).mock.calls[0][0];
    // The attendee cut moved client-side (selectBusyEvents) so HOLD
    // placeholders — attendee-less by design — can still block slots.
    expect(callArg).not.toHaveProperty('attendeeEmails');
  });

  describe('selectBusyEvents', () => {
    const TECH = ['mike@attackacrack.com', 'harrringtonm@gmail.com'];
    const ev = (summary: string, attendees: string[]) =>
      ({ summary, attendees } as unknown as CalendarEvent);

    it('keeps Mike-attended events and drops Zoom/private/non-tech events', () => {
      const kept = selectBusyEvents(
        [
          ev('Jane Smith — crack injection', ['Mike@AttackACrack.com']),
          ev('Ed / Matt 121', ['ed@example.com']),
          ev('BNI Plus', []),
          ev('Dentist', []),
        ],
        TECH,
      );
      expect(kept.map((e) => e.summary)).toEqual(['Jane Smith — crack injection']);
    });

    it('keeps attendee-less HOLD placeholders', () => {
      const kept = selectBusyEvents(
        [ev('HOLD — John Smith', []), ev('Holiday party', [])],
        TECH,
      );
      expect(kept.map((e) => e.summary)).toEqual(['HOLD — John Smith']);
    });

    it('keeps everything when no technicianEmails are configured (degraded mode)', () => {
      const events = [ev('Ed / Matt 121', ['ed@example.com']), ev('BNI Plus', [])];
      expect(selectBusyEvents(events, [])).toEqual(events);
    });

    it('keeps attendee-less Mike OOO entries (2026-10-15 gap)', () => {
      const kept = selectBusyEvents(
        [
          ev('Mike OOO', []),
          ev('Mike out of office', []),
          ev('mike ooo — hunting trip', []),
          ev('Matt OOO', []), // Matt's absence never blocks Mike's jobs
          ev('OOO', []), // ambiguous — whose? don't block
          ev('Smith vacation home — crack injection', []), // customer event, not OOO
        ],
        TECH,
      );
      expect(kept.map((e) => e.summary)).toEqual([
        'Mike OOO',
        'Mike out of office',
        'mike ooo — hunting trip',
      ]);
    });
  });
});
