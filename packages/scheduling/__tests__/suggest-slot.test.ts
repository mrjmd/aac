import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { suggestSlot } from '../src/suggest-slot.js';
import type {
  SchedulingDirective,
  QuoteApprovedDirective,
  AssessmentRequestedDirective,
  ManualScheduleDirective,
} from '../src/types.js';
import type { DurationPrediction } from '@aac/quoting';

// ── fixtures ──────────────────────────────────────────────────────

const NOW = new Date('2026-06-01T13:00:00.000Z'); // Monday 9am ET (EDT, UTC-4)

function basePrediction(overrides: Partial<DurationPrediction> = {}): DurationPrediction {
  return {
    point: 3,
    p25: 2,
    p75: 4,
    cv: 0.2,
    confidence: 'high',
    category: 'crack_injection',
    signals: [],
    rationale: 'test',
    similar: [],
    isMultiDay: false,
    workdayCount: 1,
    ...overrides,
  };
}

function quoteApproved(
  overrides: Partial<QuoteApprovedDirective> = {},
): QuoteApprovedDirective {
  return {
    id: '01HQTEST',
    createdAt: NOW.toISOString(),
    source: 'qb_webhook',
    intent: 'quote_approved',
    eventClass: 'job',
    confidence: { score: 1, signals: [] },
    customerPhone: '+16175550123',
    scopeSummary: 'test scope',
    estimatedDurationHours: 3,
    durationPrediction: basePrediction(),
    ...overrides,
  };
}

function assessment(
  overrides: Partial<AssessmentRequestedDirective> = {},
): AssessmentRequestedDirective {
  return {
    id: '01HQASS',
    createdAt: NOW.toISOString(),
    source: 'quo_text',
    intent: 'assessment_requested',
    eventClass: 'assessment',
    confidence: { score: 0.8, signals: [] },
    customerPhone: '+16175550123',
    scopeSummary: 'wants someone to look at a crack',
    estimatedDurationHours: null,
    durationPrediction: null,
    ...overrides,
  };
}

function manualSchedule(
  overrides: Partial<ManualScheduleDirective> = {},
): ManualScheduleDirective {
  return {
    id: '01HQMAN',
    createdAt: NOW.toISOString(),
    source: 'quo_outbound',
    intent: 'manual_schedule',
    eventClass: 'job',
    confidence: { score: 1, signals: [] },
    customerPhone: '+16175550123',
    scopeSummary: 'manual scheduled job',
    estimatedDurationHours: 3,
    durationPrediction: basePrediction(),
    ...overrides,
  };
}

function ev(start: string, end: string, colorId?: string): CalendarEvent {
  return {
    id: `e-${start}`,
    summary: 'test',
    description: '',
    start,
    end,
    colorId,
    attendees: [],
  };
}

// ── tests ─────────────────────────────────────────────────────────

describe('suggestSlot', () => {
  it('returns 8am ET tomorrow when calendar is empty (3h crack-injection)', () => {
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    // 2026-06-02 08:00 EDT = 12:00 UTC
    expect(result.slot!.startIso).toBe('2026-06-02T12:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T15:00:00.000Z');
    expect(result.durationSource).toBe('prediction');
    expect(result.exceededSoftCap).toBe(false);
  });

  it('skips weekends — Friday → Monday gap', () => {
    // NOW = Mon Jun 1. earliestDayOffset=1 → Tue. Walk through to Friday Jun 5,
    // then skip Sat/Sun and land on Mon Jun 8 if everything earlier is full.
    const busy: CalendarEvent[] = [];
    for (const day of ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']) {
      // Fully block working hours on Tue–Fri with a job each
      busy.push(ev(`${day}T12:00:00Z`, `${day}T21:00:00Z`, '10'));
    }
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: busy,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    // Mon Jun 8 08:00 EDT = 12:00 UTC
    expect(result.slot!.startIso).toBe('2026-06-08T12:00:00.000Z');
  });

  it('respects soft cap of 2 jobs/day — skips a day already at cap', () => {
    // Tue Jun 2 has 2 short jobs. Wed Jun 3 has none.
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '10'),
      ev('2026-06-02T13:00:00Z', '2026-06-02T14:00:00Z', '10'),
    ];
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    expect(result.slot!.startIso).toBe('2026-06-03T12:00:00.000Z');
    expect(result.exceededSoftCap).toBe(false);
  });

  it('relaxes soft cap when every under-cap day in window has no free window', () => {
    // Build 21 days where every weekday has 2 short jobs early AND a wall after.
    // The only place a 3h block fits is on the days that are AT cap (with a
    // long late-afternoon gap), forcing the second pass to relax the cap.
    const events: CalendarEvent[] = [];
    // Strategy: every weekday gets 2 jobs in 8–10am AND a wall 10am–5pm.
    // Then second-pass also can't find a gap.
    // To force the relax path, give weekdays with 2 jobs a HUGE free window
    // (so they're chosen on pass 2), and weekdays with 0/1 jobs no free window.
    // Easier: every weekday in window has 2 jobs at 8–10am only, leaving 10–17
    // free (7h). Pass 1 skips them all. Pass 2 picks the first one.
    for (let i = 1; i <= 25; i++) {
      const day = new Date(NOW.getTime() + i * 86_400_000);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const key = day.toISOString().slice(0, 10);
      events.push(ev(`${key}T12:00:00Z`, `${key}T13:00:00Z`, '10'));
      events.push(ev(`${key}T13:00:00Z`, `${key}T14:00:00Z`, '10'));
    }
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    expect(result.exceededSoftCap).toBe(true);
    // First weekday in window is Tue Jun 2 — at cap, but second pass picks 14:00 UTC (10am ET)
    expect(result.slot!.startIso).toBe('2026-06-02T14:00:00.000Z');
    expect(result.reasoning).toMatch(/relaxed soft cap/);
  });

  it('returns null with reasoning when every day is fully blocked', () => {
    const events: CalendarEvent[] = [];
    for (let i = 1; i <= 25; i++) {
      const day = new Date(NOW.getTime() + i * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      // Wall across the entire workday — both passes will find no slot
      events.push(ev(`${key}T11:00:00Z`, `${key}T22:00:00Z`, '5')); // colorId='5' = callback, doesn't count toward cap
    }
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).toBeNull();
    expect(result.reasoning).toMatch(/fully booked through/);
    expect(result.daysConsidered).toBe(15); // 21 days, ~6 weekend skips
  });

  it('uses assessment_default for assessment_requested without prediction', () => {
    const result = suggestSlot({
      directive: assessment(),
      existingEvents: [],
      now: NOW,
    });
    expect(result.durationHours).toBe(1);
    expect(result.durationSource).toBe('assessment_default');
    expect(result.slot!.startIso).toBe('2026-06-02T12:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T13:00:00.000Z');
  });

  it('uses job_default for quote_approved with no prediction', () => {
    const result = suggestSlot({
      directive: quoteApproved({ durationPrediction: null, estimatedDurationHours: null }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.durationHours).toBe(2);
    expect(result.durationSource).toBe('job_default');
  });

  it('refuses multi-day predictions', () => {
    const result = suggestSlot({
      directive: quoteApproved({
        durationPrediction: basePrediction({ isMultiDay: true, workdayCount: 2, point: 12 }),
      }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.slot).toBeNull();
    expect(result.reasoning).toMatch(/multi-day/);
    expect(result.reasoning).toMatch(/2 workdays/);
  });

  it('returns knownSlot verbatim for manual_schedule with knownSlot', () => {
    const result = suggestSlot({
      directive: manualSchedule({
        knownSlot: { startIso: '2026-06-15T14:00:00.000Z', endIso: '2026-06-15T17:00:00.000Z' },
      }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.slot).toEqual({
      startIso: '2026-06-15T14:00:00.000Z',
      endIso: '2026-06-15T17:00:00.000Z',
    });
    expect(result.durationSource).toBe('known_slot');
    expect(result.daysConsidered).toBe(0);
  });

  it('computes endIso from duration when knownSlot has no end', () => {
    const result = suggestSlot({
      directive: manualSchedule({
        knownSlot: { startIso: '2026-06-15T14:00:00.000Z' },
      }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-15T14:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-15T17:00:00.000Z'); // 3h prediction
  });

  it('fits a 3h slot between two existing events on the same day', () => {
    // Tue Jun 2: event 8–9am, event 1–3pm. 9am–1pm = 4h gap → 3h slot starts at 9am.
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '3'),  // 8–9am ET, assessment (doesn't hit job cap)
      ev('2026-06-02T17:00:00Z', '2026-06-02T19:00:00Z', '10'), // 1–3pm ET, job
    ];
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T13:00:00.000Z'); // 9am ET
    expect(result.slot!.endIso).toBe('2026-06-02T16:00:00.000Z');   // 12pm ET
  });

  it('uses tail gap after the last event of the day', () => {
    // Tue Jun 2: event 8am–2pm. Tail = 2pm–5pm = 3h. 3h job fits.
    const events = [ev('2026-06-02T12:00:00Z', '2026-06-02T18:00:00Z', '10')];
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T18:00:00.000Z'); // 2pm ET
    expect(result.slot!.endIso).toBe('2026-06-02T21:00:00.000Z');   // 5pm ET
  });

  it('only colorId=10 counts toward the soft cap (assessments/callbacks ignored)', () => {
    // Tue Jun 2: 2 assessments + 1 callback. Total 3 events but 0 jobs.
    // Soft cap should NOT trigger — should still slot on Tue.
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '3'),
      ev('2026-06-02T13:00:00Z', '2026-06-02T14:00:00Z', '3'),
      ev('2026-06-02T14:00:00Z', '2026-06-02T15:00:00Z', '5'),
    ];
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T15:00:00.000Z'); // 11am ET tail
    expect(result.exceededSoftCap).toBe(false);
  });

  it('handles EST (winter) timezone offset correctly', () => {
    // NOW = Tue Dec 8 2026, when NY is EST (UTC-5).
    const winterNow = new Date('2026-12-08T13:00:00.000Z');
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: winterNow,
    });
    // Wed Dec 9 08:00 EST = 13:00 UTC
    expect(result.slot!.startIso).toBe('2026-12-09T13:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-12-09T16:00:00.000Z');
  });

  it('passes through across the spring-forward DST boundary (Mar 8 2026)', () => {
    // NOW = Fri Mar 6 2026 (EST). Tomorrow is Sat (skip). Next weekday is Mon Mar 9 (EDT).
    const dstNow = new Date('2026-03-06T13:00:00.000Z');
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: dstNow,
    });
    // Mon Mar 9 08:00 EDT = 12:00 UTC
    expect(result.slot!.startIso).toBe('2026-03-09T12:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-03-09T15:00:00.000Z');
  });

  it('honors policy override for skipWeekends', () => {
    // NOW = Mon. earliest = Tue. With skipWeekends=false, Sat Jun 6 still wouldn't
    // be picked because Tue–Fri are free first. Override the start instead:
    // empty calendar + earliestDayOffset=5 (= Sat) + skipWeekends=false → Sat slot.
    const result = suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: NOW,
      policy: { skipWeekends: false, earliestDayOffset: 5 },
    });
    expect(result.slot!.startIso).toBe('2026-06-06T12:00:00.000Z'); // Sat Jun 6 8am ET
  });
});
