import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleCalendarClient, CalendarEvent } from '@aac/api-clients/google-calendar';
import {
  executeHoldEvent,
  getOfferedSlot,
  HOLD_COLOR_ID,
  HOLD_CUSTOMER_PHONE_LABEL,
  HOLD_OFFERED_AT_LABEL,
  HOLD_TITLE_PREFIX,
  type ExecuteHoldDeps,
} from '../src/execute-hold.js';
import type {
  AppointmentConfirmedDirective,
  ManualScheduleDirective,
} from '../src/types.js';

const NOW = new Date('2026-09-30T15:00:00.000Z');
const SLOT_START = '2026-10-06T14:00:00.000Z'; // future

function makeOffered(overrides: Partial<ManualScheduleDirective> = {}): ManualScheduleDirective {
  return {
    id: 'dir-offer-1',
    createdAt: NOW.toISOString(),
    source: 'quo_outbound',
    intent: 'manual_schedule',
    eventClass: 'job',
    confidence: { score: 0.85, signals: ['matt_outbound_intent'] },
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    scopeSummary: 'crack injection, front wall',
    estimatedDurationHours: null,
    durationPrediction: null,
    knownSlot: { startIso: SLOT_START },
    slotCommitment: 'offered',
    ...overrides,
  };
}

function makeConfirmed(): AppointmentConfirmedDirective {
  return {
    id: 'dir-conf-1',
    createdAt: NOW.toISOString(),
    source: 'quo_text',
    intent: 'appointment_confirmed',
    eventClass: 'assessment',
    confidence: { score: 0.88, signals: ['customer_confirmed_offered_slot'] },
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    scopeSummary: 'basement assessment',
    estimatedDurationHours: null,
    durationPrediction: null,
    knownSlot: { startIso: SLOT_START },
  };
}

function makeDeps(existingEvents: Partial<CalendarEvent>[] = []) {
  const listEvents = vi.fn().mockResolvedValue(existingEvents as CalendarEvent[]);
  const createEvent = vi.fn().mockResolvedValue({
    id: 'evt-hold',
    htmlLink: 'https://calendar.google.com/event?id=evt-hold',
    summary: 'HOLD — Test',
  } as CalendarEvent);
  const deps: ExecuteHoldDeps = {
    cal: { listEvents, createEvent } as unknown as GoogleCalendarClient,
    now: () => NOW,
  };
  return { deps, listEvents, createEvent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOfferedSlot', () => {
  it('returns the slot for an offered manual schedule', () => {
    expect(getOfferedSlot(makeOffered())).toEqual({ startIso: SLOT_START });
  });

  it('returns null for a booked manual schedule (stub path owns it)', () => {
    expect(getOfferedSlot(makeOffered({ slotCommitment: 'booked' }))).toBeNull();
  });

  it('returns null when slotCommitment is absent (legacy ambiguity — no calendar writes)', () => {
    const d = makeOffered();
    delete d.slotCommitment;
    expect(getOfferedSlot(d)).toBeNull();
  });

  it('returns null for appointment_confirmed (that is an agreed slot)', () => {
    expect(getOfferedSlot(makeConfirmed())).toBeNull();
  });

  it('returns null when the offer carries no slot', () => {
    const d = makeOffered();
    delete d.knownSlot;
    expect(getOfferedSlot(d)).toBeNull();
  });
});

describe('executeHoldEvent', () => {
  const baseInput = {
    customerName: 'Jane Smith',
    customerAddress: '115 St Claire St, Braintree, MA',
  };

  it('creates a graphite HOLD with no attendees and parseable metadata', async () => {
    const { deps, createEvent } = makeDeps();

    const result = await executeHoldEvent(deps, { directive: makeOffered(), ...baseInput });

    expect(result.status).toBe('created');
    const call = createEvent.mock.calls[0][0];
    expect(call.summary).toBe(`${HOLD_TITLE_PREFIX}Jane Smith`);
    expect(call.colorId).toBe(HOLD_COLOR_ID);
    expect(call.attendees).toBeUndefined();
    expect(call.sendUpdates).toBe('none');
    expect(call.location).toBe('115 St Claire St, Braintree, MA');
    expect(call.description).toContain(`${HOLD_OFFERED_AT_LABEL} ${NOW.toISOString()}`);
    expect(call.description).toContain(`${HOLD_CUSTOMER_PHONE_LABEL} +16175550123`);
    expect(call.description).toContain('dir-offer-1');
    // job default duration mirrors the stub default (3.5h)
    const durMin = (new Date(call.end).getTime() - new Date(call.start).getTime()) / 60000;
    expect(durMin).toBe(210);
  });

  it('skips non-offered directives', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeHoldEvent(deps, {
      directive: makeOffered({ slotCommitment: 'booked' }),
      ...baseInput,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no_slot' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('skips a slot in the past', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeHoldEvent(deps, {
      directive: makeOffered({ knownSlot: { startIso: '2026-09-29T14:00:00.000Z' } }),
      ...baseInput,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'slot_in_past' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('skips when any event for the customer already sits near the slot', async () => {
    const { deps, createEvent } = makeDeps([
      { id: 'evt-existing', summary: 'HOLD — Jane Smith' },
    ]);
    const result = await executeHoldEvent(deps, { directive: makeOffered(), ...baseInput });
    expect(result).toEqual({ status: 'skipped', reason: 'duplicate_event' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('creates when nearby events belong to other customers', async () => {
    const { deps, createEvent } = makeDeps([
      { id: 'evt-other', summary: 'Bob Jones — resurfacing' },
    ]);
    const result = await executeHoldEvent(deps, { directive: makeOffered(), ...baseInput });
    expect(result.status).toBe('created');
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('omits location when no address is known', async () => {
    const { deps, createEvent } = makeDeps();
    await executeHoldEvent(deps, {
      directive: makeOffered(),
      customerName: 'Jane Smith',
      customerAddress: null,
    });
    expect(createEvent.mock.calls[0][0].location).toBeUndefined();
  });

  it('honors an explicit endIso over the default duration', async () => {
    const { deps, createEvent } = makeDeps();
    await executeHoldEvent(deps, {
      directive: makeOffered({
        knownSlot: { startIso: SLOT_START, endIso: '2026-10-06T15:00:00.000Z' },
      }),
      ...baseInput,
    });
    expect(new Date(createEvent.mock.calls[0][0].end).toISOString()).toBe(
      '2026-10-06T15:00:00.000Z',
    );
  });
});

describe('executeHoldEvent — suggestedSlot variant (quote_approved suggestion flow)', () => {
  function makeQuoteApproved() {
    return {
      id: 'dir-qa-1',
      createdAt: NOW.toISOString(),
      source: 'qb_webhook',
      intent: 'quote_approved',
      eventClass: 'job',
      confidence: { score: 1, signals: [] },
      customerPhone: '+16175550123',
      pdPersonId: 9001,
      qbEstimateId: 'qb-est-1',
      scopeSummary: 'crack injection, front wall',
      estimatedDurationHours: 4,
      durationPrediction: null,
    } as const;
  }

  it('creates a hold on the suggested slot with SUGGESTED wording', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeHoldEvent(deps, {
      directive: makeQuoteApproved() as unknown as ManualScheduleDirective,
      customerName: 'Jane Smith',
      customerAddress: '42 Beacon St, Boston, MA',
      suggestedSlot: { startIso: SLOT_START, endIso: '2026-10-06T18:00:00.000Z' },
    });
    expect(result.status).toBe('created');
    const args = createEvent.mock.calls[0][0];
    expect(args.summary).toBe(`${HOLD_TITLE_PREFIX}Jane Smith`);
    expect(args.colorId).toBe(HOLD_COLOR_ID);
    expect(args.start).toBe(SLOT_START);
    expect(args.end).toBe('2026-10-06T18:00:00.000Z');
    expect(args.description).toContain('Slot SUGGESTED for Jane Smith');
    expect(args.description).toContain('NOT yet offered');
    expect(args.description).toContain(HOLD_OFFERED_AT_LABEL);
    expect(args.description).toContain(`${HOLD_CUSTOMER_PHONE_LABEL} +16175550123`);
  });

  it('still skips via the duplicate guard with a suggestedSlot', async () => {
    const { deps, createEvent } = makeDeps([
      {
        id: 'existing',
        summary: 'Jane Smith crack injection',
        start: SLOT_START,
        end: '2026-10-06T18:00:00.000Z',
        attendees: [],
        htmlLink: '',
        attachments: [],
      },
    ]);
    const result = await executeHoldEvent(deps, {
      directive: makeQuoteApproved() as unknown as ManualScheduleDirective,
      customerName: 'Jane Smith',
      suggestedSlot: { startIso: SLOT_START },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'duplicate_event' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('keeps OFFERED wording when no suggestedSlot is passed', async () => {
    const { deps, createEvent } = makeDeps();
    await executeHoldEvent(deps, {
      directive: makeOffered(),
      customerName: 'Jane Smith',
    });
    expect(createEvent.mock.calls[0][0].description).toContain('Time OFFERED to Jane Smith');
  });
});
