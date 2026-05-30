import { describe, it, expect, vi } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { suggestSlot, type SuggestSlotTravelDeps } from '../src/suggest-slot.js';
import type { TravelLeg } from '../src/travel-time.js';
import type {
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

function ev(
  start: string,
  end: string,
  colorId?: string,
  location?: string,
): CalendarEvent {
  return {
    id: `e-${start}`,
    summary: 'test',
    description: '',
    start,
    end,
    colorId,
    location,
    attendees: [],
  };
}

// ── tests ─────────────────────────────────────────────────────────

describe('suggestSlot — v0 (no travel)', () => {
  it('returns 8am ET tomorrow when calendar is empty (3h crack-injection)', async () => {
    const result = await suggestSlot({
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
    expect(result.travelAware).toBe(false);
  });

  it('skips weekends — Friday → Monday gap', async () => {
    const busy: CalendarEvent[] = [];
    for (const day of ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']) {
      busy.push(ev(`${day}T12:00:00Z`, `${day}T21:00:00Z`, '10'));
    }
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: busy,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    expect(result.slot!.startIso).toBe('2026-06-08T12:00:00.000Z');
  });

  it('respects soft cap of 2 jobs/day — skips a day already at cap', async () => {
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '10'),
      ev('2026-06-02T13:00:00Z', '2026-06-02T14:00:00Z', '10'),
    ];
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    expect(result.slot!.startIso).toBe('2026-06-03T12:00:00.000Z');
    expect(result.exceededSoftCap).toBe(false);
  });

  it('relaxes soft cap when every under-cap day in window has no free window', async () => {
    const events: CalendarEvent[] = [];
    for (let i = 1; i <= 25; i++) {
      const day = new Date(NOW.getTime() + i * 86_400_000);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const key = day.toISOString().slice(0, 10);
      events.push(ev(`${key}T12:00:00Z`, `${key}T13:00:00Z`, '10'));
      events.push(ev(`${key}T13:00:00Z`, `${key}T14:00:00Z`, '10'));
    }
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).not.toBeNull();
    expect(result.exceededSoftCap).toBe(true);
    expect(result.slot!.startIso).toBe('2026-06-02T14:00:00.000Z');
    expect(result.reasoning).toMatch(/relaxed soft cap/);
  });

  it('returns null with reasoning when every day is fully blocked', async () => {
    const events: CalendarEvent[] = [];
    for (let i = 1; i <= 25; i++) {
      const day = new Date(NOW.getTime() + i * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      events.push(ev(`${key}T11:00:00Z`, `${key}T22:00:00Z`, '5'));
    }
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot).toBeNull();
    expect(result.reasoning).toMatch(/fully booked through/);
    expect(result.daysConsidered).toBe(15);
  });

  it('uses assessment_default (0.5h) for assessment_requested without prediction', async () => {
    const result = await suggestSlot({
      directive: assessment(),
      existingEvents: [],
      now: NOW,
    });
    expect(result.durationHours).toBe(0.5);
    expect(result.durationSource).toBe('assessment_default');
    expect(result.slot!.startIso).toBe('2026-06-02T12:00:00.000Z');
    // 8am ET + 30min = 8:30am ET = 12:30 UTC
    expect(result.slot!.endIso).toBe('2026-06-02T12:30:00.000Z');
  });

  it('uses job_default for quote_approved with no prediction', async () => {
    const result = await suggestSlot({
      directive: quoteApproved({ durationPrediction: null, estimatedDurationHours: null }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.durationHours).toBe(2);
    expect(result.durationSource).toBe('job_default');
  });

  it('refuses multi-day predictions', async () => {
    const result = await suggestSlot({
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

  it('returns knownSlot verbatim for manual_schedule with knownSlot', async () => {
    const result = await suggestSlot({
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

  it('computes endIso from duration when knownSlot has no end', async () => {
    const result = await suggestSlot({
      directive: manualSchedule({
        knownSlot: { startIso: '2026-06-15T14:00:00.000Z' },
      }),
      existingEvents: [],
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-15T14:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-15T17:00:00.000Z');
  });

  it('fits a 3h slot between two existing events on the same day', async () => {
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '3'),
      ev('2026-06-02T17:00:00Z', '2026-06-02T19:00:00Z', '10'),
    ];
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T13:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T16:00:00.000Z');
  });

  it('uses tail gap after the last event of the day', async () => {
    const events = [ev('2026-06-02T12:00:00Z', '2026-06-02T18:00:00Z', '10')];
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T18:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T21:00:00.000Z');
  });

  it('only colorId=10 counts toward the soft cap (assessments/callbacks ignored)', async () => {
    const events = [
      ev('2026-06-02T12:00:00Z', '2026-06-02T13:00:00Z', '3'),
      ev('2026-06-02T13:00:00Z', '2026-06-02T14:00:00Z', '3'),
      ev('2026-06-02T14:00:00Z', '2026-06-02T15:00:00Z', '5'),
    ];
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: events,
      now: NOW,
    });
    expect(result.slot!.startIso).toBe('2026-06-02T15:00:00.000Z');
    expect(result.exceededSoftCap).toBe(false);
  });

  it('handles EST (winter) timezone offset correctly', async () => {
    const winterNow = new Date('2026-12-08T13:00:00.000Z');
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: winterNow,
    });
    expect(result.slot!.startIso).toBe('2026-12-09T13:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-12-09T16:00:00.000Z');
  });

  it('passes through across the spring-forward DST boundary (Mar 8 2026)', async () => {
    const dstNow = new Date('2026-03-06T13:00:00.000Z');
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: dstNow,
    });
    expect(result.slot!.startIso).toBe('2026-03-09T12:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-03-09T15:00:00.000Z');
  });

  it('honors policy override for skipWeekends', async () => {
    const result = await suggestSlot({
      directive: quoteApproved(),
      existingEvents: [],
      now: NOW,
      policy: { skipWeekends: false, earliestDayOffset: 5 },
    });
    expect(result.slot!.startIso).toBe('2026-06-06T12:00:00.000Z');
  });
});

// ── Walk #6.5: travel-aware path ─────────────────────────────────

describe('suggestSlot — travel-aware', () => {
  const HOME = '30 Randlett Street, Quincy, MA 02170';

  /**
   * Build a travel mock that always returns the same duration regardless of
   * origin/destination. Useful for testing structural behavior (when does
   * a slot fit, when does the home-return constraint bind).
   */
  function constantTravel(minutes: number): SuggestSlotTravelDeps {
    return {
      homeAddress: HOME,
      getLeg: vi.fn().mockResolvedValue({
        durationSec: minutes * 60,
        distanceMeters: minutes * 1000, // garbage but consistent
      } satisfies TravelLeg),
    };
  }

  /**
   * Per-leg travel mock: caller declares (origin, destination) → minutes.
   * Returns null for unmocked routes so the test catches accidental misses.
   */
  function routedTravel(
    routes: Record<string, number>,
  ): SuggestSlotTravelDeps {
    return {
      homeAddress: HOME,
      getLeg: vi.fn().mockImplementation(
        async (origin: string, destination: string): Promise<TravelLeg | null> => {
          const key = `${origin} → ${destination}`;
          const minutes = routes[key];
          if (minutes == null) return null;
          return { durationSec: minutes * 60, distanceMeters: minutes * 1000 };
        },
      ),
    };
  }

  it('shifts first slot of day forward by home → customer drive time', async () => {
    // Empty calendar; constant 30min drive home ↔ customer.
    // Expected slot start = 8am ET + 30min = 8:30am ET (no buffer on home leg).
    const result = await suggestSlot({
      directive: assessment(), // 0.5h
      existingEvents: [],
      now: NOW,
      customerAddress: '123 Customer Ln, Boston, MA',
      travel: constantTravel(30),
    });
    expect(result.travelAware).toBe(true);
    expect(result.slot).not.toBeNull();
    // 8am ET + 30min = 8:30am ET = 12:30 UTC
    expect(result.slot!.startIso).toBe('2026-06-02T12:30:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T13:00:00.000Z');
    expect(result.reasoning).toMatch(/home → customer 30min/);
    expect(result.reasoning).toMatch(/home \(back by deadline\)/);
  });

  it('Margie scenario: Sean fills Tue 8:30–12:30, Falmouth slot lands 14:05 (12:30 + 80min + 15min buffer)', async () => {
    const SEAN = '99 Sean St, Boston, MA';
    const FALMOUTH = '5 Customer Way, Falmouth, MA';
    const sean = ev('2026-06-02T12:30:00Z', '2026-06-02T16:30:00Z', '10', SEAN);
    const routes = {
      [`${HOME} → ${FALMOUTH}`]: 90,
      [`${FALMOUTH} → ${HOME}`]: 90,
      [`${HOME} → ${SEAN}`]: 5,
      [`${SEAN} → ${FALMOUTH}`]: 80,
      [`${FALMOUTH} → ${SEAN}`]: 80,
      [`${SEAN} → ${HOME}`]: 5,
    };
    const result = await suggestSlot({
      directive: assessment({ id: '01HQMARGIE' }),
      existingEvents: [sean],
      now: NOW,
      customerAddress: FALMOUTH,
      travel: routedTravel(routes),
    });
    expect(result.travelAware).toBe(true);
    expect(result.slot).not.toBeNull();
    // 12:30 EDT = 16:30 UTC. +80min drive +15min buffer → 18:05 UTC = 14:05 EDT.
    expect(result.slot!.startIso).toBe('2026-06-02T18:05:00.000Z');
    // 0.5h on-site → 14:35 EDT = 18:35 UTC.
    expect(result.slot!.endIso).toBe('2026-06-02T18:35:00.000Z');
  });

  it('skips a day whose return-home deadline would be missed', async () => {
    // Tue Jun 2: Sean 8:30–16:30. Customer is 90min from Sean AND from home.
    // Gap after Sean: 16:30 + 90min + 15min = 18:15 earliest start (already past 17:30). Skip Tue.
    // Wed Jun 3: empty calendar. Slot fits at 8am + 90min = 9:30am ET.
    const SEAN = '99 Sean St, Boston, MA';
    const FAR = '1 Way, Far, MA';
    const sean = ev('2026-06-02T12:30:00Z', '2026-06-02T20:30:00Z', '10', SEAN);
    const routes = {
      [`${HOME} → ${FAR}`]: 90,
      [`${FAR} → ${HOME}`]: 90,
      [`${HOME} → ${SEAN}`]: 10,
      [`${SEAN} → ${FAR}`]: 90,
      [`${FAR} → ${SEAN}`]: 90,
      [`${SEAN} → ${HOME}`]: 10,
    };
    const result = await suggestSlot({
      directive: assessment(),
      existingEvents: [sean],
      now: NOW,
      customerAddress: FAR,
      travel: routedTravel(routes),
    });
    expect(result.travelAware).toBe(true);
    expect(result.slot).not.toBeNull();
    // Wed Jun 3 08:00 EDT + 90min = 09:30 EDT = 13:30 UTC.
    expect(result.slot!.startIso).toBe('2026-06-03T13:30:00.000Z');
  });

  it('returns null when no day allows a feasible round-trip in window', async () => {
    // Customer is 4 hours from home → home→customer drive alone (240min)
    // means slot can't start before 12pm, then 0.5h on-site, then 4h back =
    // 16:30. + 15min buffer = 16:45 — under 17:30! Should fit. Push to 5h:
    // 8 + 300 = 13:00 ET start. +0.5 = 13:30. +5h = 18:30 + 15 = 18:45 → past 17:30. Fails.
    const FAR = '1 Way, Maine';
    const routes = {
      [`${HOME} → ${FAR}`]: 300,
      [`${FAR} → ${HOME}`]: 300,
    };
    const result = await suggestSlot({
      directive: assessment(),
      existingEvents: [],
      now: NOW,
      customerAddress: FAR,
      travel: routedTravel(routes),
    });
    expect(result.slot).toBeNull();
    expect(result.reasoning).toMatch(/respects drive time/);
  });

  it('falls back to v0 when customerAddress is empty (with travel deps still provided)', async () => {
    const result = await suggestSlot({
      directive: assessment(),
      existingEvents: [],
      now: NOW,
      customerAddress: '',
      travel: constantTravel(45),
    });
    expect(result.travelAware).toBe(false);
    // 8am ET, 0.5h slot.
    expect(result.slot!.startIso).toBe('2026-06-02T12:00:00.000Z');
    expect(result.slot!.endIso).toBe('2026-06-02T12:30:00.000Z');
  });

  it('skips a gap when Maps returns null for the inbound leg', async () => {
    // Empty calendar; getLeg returns null → all gaps skipped → result null.
    const travel: SuggestSlotTravelDeps = {
      homeAddress: HOME,
      getLeg: vi.fn().mockResolvedValue(null),
    };
    const result = await suggestSlot({
      directive: assessment(),
      existingEvents: [],
      now: NOW,
      customerAddress: '1 Anywhere, MA',
      travel,
    });
    expect(result.slot).toBeNull();
    expect(result.travelAware).toBe(true);
  });
});
