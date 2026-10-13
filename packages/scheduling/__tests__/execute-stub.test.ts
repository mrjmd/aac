import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleCalendarClient, CalendarEvent } from '@aac/api-clients/google-calendar';
import {
  enrichStubEvent,
  executeStubEvent,
  getActionableSlot,
  EVENT_CLASS_COLOR_IDS,
  STUB_DEFAULT_HOURS,
  STUB_TITLE_PREFIX,
  type ExecuteStubDeps,
} from '../src/execute-stub.js';
import type {
  AppointmentConfirmedDirective,
  ManualScheduleDirective,
  QuoteApprovedDirective,
} from '../src/types.js';

const NOW = new Date('2026-09-30T15:00:00.000Z');
const SLOT_START = '2026-10-06T14:00:00.000Z'; // future

function makeManual(overrides: Partial<ManualScheduleDirective> = {}): ManualScheduleDirective {
  return {
    id: 'dir-manual-1',
    createdAt: NOW.toISOString(),
    source: 'quo_outbound',
    intent: 'manual_schedule',
    eventClass: 'job',
    confidence: { score: 0.88, signals: ['matt_outbound_intent'] },
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    scopeSummary: 'crack injection, front wall',
    estimatedDurationHours: null,
    durationPrediction: null,
    knownSlot: { startIso: SLOT_START },
    slotCommitment: 'booked',
    ...overrides,
  };
}

function makeConfirmed(
  overrides: Partial<AppointmentConfirmedDirective> = {},
): AppointmentConfirmedDirective {
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
    ...overrides,
  };
}

function makeQuoteApproved(): QuoteApprovedDirective {
  return {
    id: 'dir-qa-1',
    createdAt: NOW.toISOString(),
    source: 'qb_webhook',
    intent: 'quote_approved',
    eventClass: 'job',
    confidence: { score: 0.9, signals: [] },
    customerPhone: '+16175550123',
    scopeSummary: 'approved quote',
    estimatedDurationHours: null,
    durationPrediction: null,
  };
}

function makeDeps(existingEvents: Partial<CalendarEvent>[] = []) {
  const listEvents = vi.fn().mockResolvedValue(existingEvents as CalendarEvent[]);
  const createEvent = vi.fn().mockResolvedValue({
    id: 'evt-new',
    htmlLink: 'https://calendar.google.com/event?id=evt-new',
    summary: 'STUB — Test',
  } as CalendarEvent);
  const deleteEvent = vi.fn().mockResolvedValue(undefined);
  const updateEvent = vi.fn().mockResolvedValue({ id: 'evt-new' } as CalendarEvent);
  const deps: ExecuteStubDeps = {
    cal: { listEvents, createEvent, deleteEvent, updateEvent } as unknown as GoogleCalendarClient,
    now: () => NOW,
  };
  return { deps, listEvents, createEvent, deleteEvent, updateEvent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getActionableSlot', () => {
  it('returns the slot for a booked manual schedule', () => {
    expect(getActionableSlot(makeManual())).toEqual({ startIso: SLOT_START });
  });

  it('returns null for an offered manual schedule', () => {
    expect(getActionableSlot(makeManual({ slotCommitment: 'offered' }))).toBeNull();
  });

  it('returns null when slotCommitment is absent (pre-field directives)', () => {
    const d = makeManual();
    delete d.slotCommitment;
    expect(getActionableSlot(d)).toBeNull();
  });

  it('returns the slot for appointment_confirmed', () => {
    expect(getActionableSlot(makeConfirmed())).toEqual({ startIso: SLOT_START });
  });

  it('returns null for non-slot-bearing intents', () => {
    expect(getActionableSlot(makeQuoteApproved())).toBeNull();
  });
});

describe('executeStubEvent', () => {
  const baseInput = {
    customerName: 'Jane Smith',
    customerAddress: '115 St Claire St, Braintree, MA',
    technicianEmails: ['mike@attackacrack.com'],
  };

  it('creates a STUB event with class color, default duration, and silent attendee', async () => {
    const { deps, createEvent } = makeDeps();

    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });

    expect(result.status).toBe('created');
    const call = createEvent.mock.calls[0][0];
    expect(call.summary).toBe(`${STUB_TITLE_PREFIX}Jane Smith`);
    expect(call.colorId).toBe(EVENT_CLASS_COLOR_IDS.assessment);
    expect(call.location).toBe('115 St Claire St, Braintree, MA');
    expect(call.attendees).toEqual(['mike@attackacrack.com']);
    expect(call.sendUpdates).toBe('none');
    expect(call.description).toContain('basement assessment');
    expect(call.description).toContain('dir-conf-1');
    // assessment default = 30 min
    const durMin = (new Date(call.end).getTime() - new Date(call.start).getTime()) / 60000;
    expect(durMin).toBe(STUB_DEFAULT_HOURS.assessment * 60);
  });

  it('uses 3.5h default for booked jobs and callbacks', async () => {
    const { deps, createEvent } = makeDeps();

    await executeStubEvent(deps, { directive: makeManual(), ...baseInput });
    const jobCall = createEvent.mock.calls[0][0];
    expect(jobCall.colorId).toBe('10');
    const jobMin = (new Date(jobCall.end).getTime() - new Date(jobCall.start).getTime()) / 60000;
    expect(jobMin).toBe(210);

    await executeStubEvent(deps, {
      directive: makeManual({ eventClass: 'callback', id: 'dir-manual-2' }),
      ...baseInput,
    });
    const cbCall = createEvent.mock.calls[1][0];
    expect(cbCall.colorId).toBe('5');
    const cbMin = (new Date(cbCall.end).getTime() - new Date(cbCall.start).getTime()) / 60000;
    expect(cbMin).toBe(210);
  });

  it('honors an explicit endIso over the default duration', async () => {
    const { deps, createEvent } = makeDeps();
    const directive = makeConfirmed({
      knownSlot: { startIso: SLOT_START, endIso: '2026-10-06T16:00:00.000Z' },
    });

    await executeStubEvent(deps, { directive, ...baseInput });
    const call = createEvent.mock.calls[0][0];
    expect(new Date(call.end).toISOString()).toBe('2026-10-06T16:00:00.000Z');
  });

  it('skips offered manual-schedule slots (waiting on customer yes)', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeStubEvent(deps, {
      directive: makeManual({ slotCommitment: 'offered' }),
      ...baseInput,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no_slot' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('skips a slot in the past', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeStubEvent(deps, {
      directive: makeConfirmed({ knownSlot: { startIso: '2026-09-29T14:00:00.000Z' } }),
      ...baseInput,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'slot_in_past' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('skips an unparseable slot', async () => {
    const { deps, createEvent } = makeDeps();
    const result = await executeStubEvent(deps, {
      directive: makeConfirmed({ knownSlot: { startIso: 'not-a-date' } }),
      ...baseInput,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no_slot' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('skips when an event for the same customer already exists near the slot', async () => {
    const { deps, createEvent } = makeDeps([
      { id: 'evt-existing', summary: 'Jane Smith — crack injection' },
    ]);
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result).toEqual({ status: 'skipped', reason: 'duplicate_event' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('matches duplicates case-insensitively (including prior stubs)', async () => {
    const { deps, createEvent } = makeDeps([
      { id: 'evt-stub', summary: 'STUB — JANE SMITH' },
    ]);
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result).toEqual({ status: 'skipped', reason: 'duplicate_event' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('releases a HOLD placeholder for the same customer and creates the stub', async () => {
    const { deps, createEvent, deleteEvent } = makeDeps([
      { id: 'evt-hold', summary: 'HOLD — Jane Smith' },
    ]);
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result.status).toBe('created');
    expect(deleteEvent).toHaveBeenCalledWith('evt-hold');
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('still creates the stub when releasing the hold fails', async () => {
    const { deps, createEvent, deleteEvent } = makeDeps([
      { id: 'evt-hold', summary: 'HOLD — Jane Smith' },
    ]);
    deleteEvent.mockRejectedValueOnce(new Error('410 Gone'));
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result.status).toBe('created');
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('a real (non-hold) duplicate still wins over hold cleanup', async () => {
    const { deps, createEvent, deleteEvent } = makeDeps([
      { id: 'evt-hold', summary: 'HOLD — Jane Smith' },
      { id: 'evt-real', summary: 'Jane Smith — crack injection' },
    ]);
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result).toEqual({ status: 'skipped', reason: 'duplicate_event' });
    expect(createEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('creates when nearby events are for other customers', async () => {
    const { deps, createEvent } = makeDeps([
      { id: 'evt-other', summary: 'Bob Jones — resurfacing' },
    ]);
    const result = await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput });
    expect(result.status).toBe('created');
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('omits location when no address is known', async () => {
    const { deps, createEvent } = makeDeps();
    await executeStubEvent(deps, {
      directive: makeConfirmed(),
      customerName: 'Jane Smith',
      customerAddress: null,
      technicianEmails: [],
    });
    const call = createEvent.mock.calls[0][0];
    expect(call.location).toBeUndefined();
  });

  it('uses a pre-built description and keeps the provenance footer', async () => {
    const { deps, createEvent } = makeDeps();

    await executeStubEvent(deps, {
      directive: makeConfirmed(),
      ...baseInput,
      description: 'NOTE: gate code 1234.\n\nWet basement NE corner, go have a look.',
    });

    const call = createEvent.mock.calls[0][0];
    expect(call.description).toContain('NOTE: gate code 1234.');
    expect(call.description).toContain('Wet basement NE corner');
    expect(call.description).toContain('Auto-created stub from quo_text directive dir-conf-1');
    // the raw scopeSummary is replaced, not duplicated
    expect(call.description).not.toMatch(/^basement assessment/);
  });

  it('passes photo attachments through to the calendar event', async () => {
    const { deps, createEvent } = makeDeps();
    const attachments = [
      { fileUrl: 'https://drive.google.com/open?id=F1', title: 'a.jpg', mimeType: 'image/jpeg' },
      { fileUrl: 'https://drive.google.com/open?id=F2', title: 'b.jpg', mimeType: 'image/jpeg' },
    ];

    await executeStubEvent(deps, {
      directive: makeConfirmed(),
      ...baseInput,
      attachments,
    });

    expect(createEvent.mock.calls[0][0].attachments).toEqual(attachments);
  });

  it('omits attachments entirely when none are provided', async () => {
    const { deps, createEvent } = makeDeps();

    await executeStubEvent(deps, { directive: makeConfirmed(), ...baseInput, attachments: [] });

    expect(createEvent.mock.calls[0][0].attachments).toBeUndefined();
  });
});

describe('enrichStubEvent', () => {
  it('patches description (with provenance footer) and attachments', async () => {
    const { deps, updateEvent } = makeDeps();
    const attachments = [
      { fileUrl: 'https://drive.google.com/open?id=F1', title: 'a.jpg', mimeType: 'image/jpeg' },
    ];

    const patched = await enrichStubEvent(deps, {
      directive: makeConfirmed(),
      eventId: 'evt-new',
      description: 'Wet basement NE corner, go have a look.',
      attachments,
    });

    expect(patched).toBe(true);
    expect(updateEvent).toHaveBeenCalledTimes(1);
    const [eventId, patch] = updateEvent.mock.calls[0];
    expect(eventId).toBe('evt-new');
    expect(patch.description).toContain('go have a look');
    expect(patch.description).toContain('Auto-created stub from quo_text directive dir-conf-1');
    expect(patch.attachments).toEqual(attachments);
  });

  it('patches attachments alone, leaving the description untouched', async () => {
    const { deps, updateEvent } = makeDeps();
    const attachments = [
      { fileUrl: 'https://drive.google.com/open?id=F1', title: 'a.jpg', mimeType: 'image/jpeg' },
    ];

    const patched = await enrichStubEvent(deps, {
      directive: makeConfirmed(),
      eventId: 'evt-new',
      attachments,
    });

    expect(patched).toBe(true);
    const [, patch] = updateEvent.mock.calls[0];
    expect(patch.description).toBeUndefined();
    expect(patch.attachments).toEqual(attachments);
  });

  it('is a no-op when there is nothing to patch', async () => {
    const { deps, updateEvent } = makeDeps();

    const patched = await enrichStubEvent(deps, {
      directive: makeConfirmed(),
      eventId: 'evt-new',
      description: '   ',
      attachments: [],
    });

    expect(patched).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
