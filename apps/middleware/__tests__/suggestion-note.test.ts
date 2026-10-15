import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuoteApprovedDirective } from '@aac/scheduling';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const { mockMarkCronAction, mockLogHealthError, mockGetPendingDirective } = vi.hoisted(() => ({
  mockMarkCronAction: vi.fn(),
  mockLogHealthError: vi.fn(),
  mockGetPendingDirective: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  getPendingDirective: mockGetPendingDirective,
  logHealthError: mockLogHealthError,
  markCronAction: mockMarkCronAction,
  SCHEDULING_AUTO_PROPOSE_THRESHOLD: 0.7,
  getRedis: vi.fn(),
}));

import {
  postSuggestionNoteForDirective,
  type SuggestionNoteDeps,
} from '../lib/suggestion-note.js';

const NOW = new Date('2026-06-01T13:00:00.000Z'); // Monday 9am EDT

function makeDirective(over: Partial<QuoteApprovedDirective> = {}): QuoteApprovedDirective {
  return {
    id: 'dir_1',
    createdAt: NOW.toISOString(),
    source: 'qb_webhook',
    intent: 'quote_approved',
    eventClass: 'job',
    confidence: { score: 1, signals: [] },
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

function ev(summary: string, start: string, end: string): CalendarEvent {
  return {
    id: `e-${start}`,
    summary,
    start,
    end,
    attendees: ['mike@attackacrack.com'],
    htmlLink: '',
    attachments: [],
  };
}

interface DepsOptions {
  /** Sequence of listEvents results; last value repeats. */
  listEventsResults?: CalendarEvent[][];
  /** Constant home↔customer drive in minutes; omit for no-travel mode. */
  driveMinutes?: number;
  quoContact?: { id: string } | null;
}

function makeDeps(opts: DepsOptions = {}): SuggestionNoteDeps & {
  createEvent: ReturnType<typeof vi.fn>;
  createContactNote: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
} {
  const listEvents = vi.fn();
  const results = opts.listEventsResults ?? [[]];
  for (const r of results.slice(0, -1)) listEvents.mockResolvedValueOnce(r);
  listEvents.mockResolvedValue(results[results.length - 1]);

  const createEvent = vi.fn().mockResolvedValue({
    id: 'hold-1',
    htmlLink: 'https://cal/hold-1',
  });
  const createContactNote = vi.fn().mockResolvedValue({ id: 'note-1' });

  const deps: SuggestionNoteDeps = {
    pd: {
      getPerson: vi.fn().mockResolvedValue({ id: 9001, name: 'John Smith' }),
    } as unknown as SuggestionNoteDeps['pd'],
    qb: {
      getCustomer: vi.fn().mockResolvedValue({
        Id: 'qb-1',
        BillAddr: { Line1: '42 Beacon St', City: 'Boston', CountrySubDivisionCode: 'MA' },
      }),
    } as unknown as SuggestionNoteDeps['qb'],
    quo: {
      findContactByPhone: vi.fn().mockResolvedValue(
        opts.quoContact === undefined ? { id: 'qc-1' } : opts.quoContact,
      ),
      createContactNote,
    } as unknown as SuggestionNoteDeps['quo'],
    calendar: { listEvents, createEvent } as unknown as SuggestionNoteDeps['calendar'],
    ...(opts.driveMinutes != null
      ? {
          maps: {
            getTravelTime: vi.fn().mockResolvedValue({
              durationSec: opts.driveMinutes * 60,
              distanceMeters: opts.driveMinutes * 1000,
            }),
          } as unknown as SuggestionNoteDeps['maps'],
        }
      : {}),
    technicianEmails: ['mike@attackacrack.com'],
    now: () => NOW,
  };
  return Object.assign(deps, { createEvent, createContactNote, listEvents });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkCronAction.mockResolvedValue(true);
});

describe('postSuggestionNoteForDirective', () => {
  it('posts the tight 3-line note with a backup on a different day, and holds the primary', async () => {
    const deps = makeDeps({ driveMinutes: 30 });
    const result = await postSuggestionNoteForDirective(deps, makeDirective());

    expect(result.status).toBe('posted');
    if (result.status !== 'posted') return;
    expect(result.manual).toBe(false);
    expect(result.holdEventId).toBe('hold-1');

    const noteText = deps.createContactNote.mock.calls[0][1] as string;
    const lines = noteText.split('\n');
    expect(lines[0]).toBe('📅 John Smith looks ready to schedule — est ~4h.');
    // 30min drive bands to 8:30 AM; primary = Tue Jun 2, backup = next day.
    expect(lines[1]).toBe('Suggested: Tue, Jun 2, 8:30 AM');
    expect(lines[2]).toBe('Backup: Wed, Jun 3, 8:30 AM');
    expect(lines).toHaveLength(3);

    // HOLD created on the primary slot with suggested wording.
    const holdArgs = deps.createEvent.mock.calls[0][0];
    expect(holdArgs.summary).toBe('HOLD — John Smith');
    expect(holdArgs.colorId).toBe('8');
    expect(holdArgs.start).toBe('2026-06-02T12:30:00.000Z');
    expect(holdArgs.description).toContain('Slot SUGGESTED for John Smith');
    expect(holdArgs.description).toContain('NOT yet offered');
  });

  it('routes >90min customers to a manual note with a starting point and NO hold', async () => {
    const deps = makeDeps({ driveMinutes: 104 });
    const result = await postSuggestionNoteForDirective(deps, makeDirective());

    expect(result.status).toBe('posted');
    if (result.status !== 'posted') return;
    expect(result.manual).toBe(true);
    expect(result.holdEventId).toBeNull();
    expect(deps.createEvent).not.toHaveBeenCalled();

    const noteText = deps.createContactNote.mock.calls[0][1] as string;
    expect(noteText).toContain('needs manual scheduling: customer is ~104min drive from home');
    expect(noteText).toContain('Starting point: Tue, Jun 2, 9:00 AM');
  });

  it('routes multi-day jobs to a manual note with no slot line and NO hold', async () => {
    const deps = makeDeps();
    const directive = makeDirective({
      durationPrediction: {
        point: 12,
        p25: 10,
        p75: 14,
        cv: 0.2,
        confidence: 'high',
        rationale: 'big job',
        similarCases: [],
        isMultiDay: true,
        workdayCount: 2,
      },
    });
    const result = await postSuggestionNoteForDirective(deps, directive);

    expect(result.status).toBe('posted');
    if (result.status !== 'posted') return;
    expect(result.manual).toBe(true);
    expect(deps.createEvent).not.toHaveBeenCalled();
    const noteText = deps.createContactNote.mock.calls[0][1] as string;
    expect(noteText).toContain('needs manual scheduling: multi-day job.');
    expect(noteText).not.toContain('Starting point');
  });

  it('is at-most-once per estimate — second call skips before any side effect', async () => {
    mockMarkCronAction.mockResolvedValue(false);
    const deps = makeDeps();
    const result = await postSuggestionNoteForDirective(deps, makeDirective());
    expect(result).toEqual({ status: 'skipped', reason: 'already_posted' });
    expect(deps.createEvent).not.toHaveBeenCalled();
    expect(deps.createContactNote).not.toHaveBeenCalled();
    expect(mockMarkCronAction).toHaveBeenCalledWith('suggestion-note', 'qb-est-1', expect.any(Number));
  });

  it('skips without claiming the marker when the calendar read fails (reconcile retries)', async () => {
    const deps = makeDeps();
    deps.listEvents.mockReset();
    deps.listEvents.mockRejectedValue(new Error('calendar 500'));
    const result = await postSuggestionNoteForDirective(deps, makeDirective());
    expect(result).toEqual({ status: 'skipped', reason: 'calendar_unavailable' });
    expect(mockMarkCronAction).not.toHaveBeenCalled();
    expect(deps.createContactNote).not.toHaveBeenCalled();
  });

  it('skips with a health error (marker unclaimed) when no Quo contact matches the phone', async () => {
    const deps = makeDeps({ quoContact: null });
    const result = await postSuggestionNoteForDirective(deps, makeDirective());
    expect(result).toEqual({ status: 'skipped', reason: 'no_quo_contact' });
    expect(mockMarkCronAction).not.toHaveBeenCalled();
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('skips the note when the hold duplicate guard finds the customer already on the calendar', async () => {
    // First listEvents (busy fetch) empty; second (hold dup scan) has a
    // hand-made booking mentioning the customer.
    const deps = makeDeps({
      listEventsResults: [
        [],
        [ev('John Smith crack injection', '2026-06-02T12:00:00.000Z', '2026-06-02T16:00:00.000Z')],
      ],
    });
    const result = await postSuggestionNoteForDirective(deps, makeDirective());
    expect(result).toEqual({ status: 'skipped', reason: 'already_on_calendar' });
    expect(deps.createEvent).not.toHaveBeenCalled();
    expect(deps.createContactNote).not.toHaveBeenCalled();
  });

  it('ignores non-quote_approved directives and low-confidence ones', async () => {
    const deps = makeDeps();
    const wrongIntent = await postSuggestionNoteForDirective(
      deps,
      { ...makeDirective(), intent: 'assessment_requested' } as unknown as QuoteApprovedDirective,
    );
    expect(wrongIntent).toEqual({ status: 'skipped', reason: 'not_quote_approved' });

    const lowConf = await postSuggestionNoteForDirective(
      deps,
      makeDirective({ confidence: { score: 0.5, signals: [] } }),
    );
    expect(lowConf).toEqual({ status: 'skipped', reason: 'low_confidence' });
    expect(deps.createContactNote).not.toHaveBeenCalled();
  });
});
