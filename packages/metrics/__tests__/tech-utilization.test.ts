import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { buildTechUtilization } from '../src/index.js';

const MIKE = 'mike@attackacrack.com';
let n = 0;
function ev(over: Partial<CalendarEvent>): CalendarEvent {
  n += 1;
  return { id: `e${n}`, summary: 'Job', start: '', end: '', attendees: [], htmlLink: '', attachments: [], ...over };
}

describe('buildTechUtilization', () => {
  // Week of Mon 2026-11-02. Times in EST (-05:00).
  const events = [
    ev({ summary: 'Smith job', colorId: '10', start: '2026-11-02T08:00:00-05:00', end: '2026-11-02T14:00:00-05:00', attendees: [MIKE] }),
    ev({ summary: 'Jones assessment', colorId: '3', start: '2026-11-03T09:00:00-05:00', end: '2026-11-03T10:00:00-05:00', attendees: ['MIKE@attackacrack.com'] }),
    ev({ summary: 'Matt Zoom', start: '2026-11-03T11:00:00-05:00', end: '2026-11-03T12:00:00-05:00', attendees: ['matt@attackacrack.com'] }),
    ev({ summary: 'HOLD — Lee', colorId: '8', start: '2026-11-04T08:00:00-05:00', end: '2026-11-04T11:00:00-05:00' }),
    ev({ summary: 'Mike OOO', start: '2026-11-06', end: '2026-11-07' }),
    ev({ summary: 'Two-day resurfacing', colorId: '10', start: '2026-11-12', end: '2026-11-14', attendees: [MIKE] }),
  ];
  const weeks = buildTechUtilization({ events, techEmails: [MIKE], fromWeek: '2026-11-04', weeks: 2 });

  it('starts weeks on Monday', () => {
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-11-02', '2026-11-09']);
  });

  it('counts only events Mike attends, by length, split by color', () => {
    expect(weeks[0].bookedHours).toBe(7);
    expect(weeks[0].byType).toEqual({ job: 6, assessment: 1, callback: 0, other: 0 });
  });

  it('keeps HOLDs out of booked and takes OOO out of capacity', () => {
    expect(weeks[0].heldHours).toBe(3);
    expect(weeks[0].capacityHours).toBe(32);
    expect(weeks[0].bookedPct).toBe(0.22);
  });

  it('counts overlapping time once', () => {
    const overlap = buildTechUtilization({
      events: [
        ev({ colorId: '10', start: '2026-10-16T08:00:00-04:00', end: '2026-10-16T16:30:00-04:00', attendees: [MIKE] }),
        ev({ colorId: '5', start: '2026-10-16T10:00:00-04:00', end: '2026-10-16T17:30:00-04:00', attendees: [MIKE] }),
      ],
      techEmails: [MIKE],
      fromWeek: '2026-10-12',
      weeks: 1,
    });
    expect(overlap[0].bookedHours).toBe(9.5);
    expect(overlap[0].byType).toMatchObject({ job: 8.5, callback: 1 });
  });

  it('counts an all-day multi-day job as 8h per weekday', () => {
    expect(weeks[1].bookedHours).toBe(16);
    expect(weeks[1].bookedPct).toBe(0.4);
  });
});
