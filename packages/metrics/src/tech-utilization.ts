import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import {
  EVENT_CLASS_COLOR_IDS,
  HOLD_TITLE_PREFIX,
  isBusyEvent,
  isTechOutOfOffice,
} from '@aac/shared-utils/calendar';
import { easternDate, easternMinuteOfDay } from '@aac/shared-utils/eastern';
import { addDays, mondayOf, weekday } from './weeks.js';

/** One Monday-to-Sunday week of a technician's calendar. */
export interface TechWeek {
  /** Monday, YYYY-MM-DD (America/New_York). */
  weekStart: string;
  /** Hours of events the tech attends (event length, all-day = 8h per weekday). */
  bookedHours: number;
  byType: { job: number; assessment: number; callback: number; other: number };
  /** Offered-but-unconfirmed HOLD placeholders (not counted as booked). */
  heldHours: number;
  /** Weekdays x 8h, minus out-of-office time. */
  capacityHours: number;
  /** booked / capacity, 0-1+ (Saturday work can push it past 1). */
  bookedPct: number | null;
  /** With `withEvents`: the booked events behind `bookedHours`, each with the hours it was credited. */
  events?: Array<{ id: string; summary: string; day: string; hours: number }>;
}

export const WORKDAY_HOURS = 8;
/** One event never counts for more than a long field day. */
const MAX_EVENT_HOURS = 10;

const isAllDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const round1 = (n: number) => Math.round(n * 10) / 10;

function typeOf(e: CalendarEvent): keyof TechWeek['byType'] {
  if (e.colorId === EVENT_CLASS_COLOR_IDS.job) return 'job';
  if (e.colorId === EVENT_CLASS_COLOR_IDS.assessment) return 'assessment';
  if (e.colorId === EVENT_CLASS_COLOR_IDS.callback) return 'callback';
  return 'other';
}

/** All-day events occupy a standard 8:00-16:00 block on each weekday they cover. */
const ALL_DAY_BLOCK: [number, number] = [8 * 60, 8 * 60 + WORKDAY_HOURS * 60];

/** [day, startMinute, endMinute] pieces of an event, in local time. */
function pieces(e: CalendarEvent): Array<[string, number, number]> {
  if (isAllDay(e.start)) {
    const out: Array<[string, number, number]> = [];
    for (let d = e.start; d < e.end; d = addDays(d, 1)) if (weekday(d) % 6 !== 0) out.push([d, ...ALL_DAY_BLOCK]);
    return out;
  }
  const start = easternMinuteOfDay(e.start);
  const lengthMin = Math.min(MAX_EVENT_HOURS * 60, Math.max(0, (Date.parse(e.end) - Date.parse(e.start)) / 60_000));
  return [[easternDate(e.start), start, Math.min(24 * 60, start + lengthMin)]];
}

/** Minutes of [start, end) not already in `covered`; adds the span to `covered`. */
function claim(covered: Array<[number, number]>, start: number, end: number): number {
  let free = 0;
  let cursor = start;
  for (const [a, b] of [...covered].sort((x, y) => x[0] - y[0])) {
    if (b <= cursor || a >= end) continue;
    if (a > cursor) free += a - cursor;
    cursor = Math.max(cursor, b);
    if (cursor >= end) break;
  }
  if (cursor < end) free += end - cursor;
  covered.push([start, end]);
  return free;
}

/**
 * Pure: a technician's booked share per week. Booked = events with one of
 * `techEmails` as an attendee, by event length (Matt, 11/03); overlapping
 * events count their shared time once (earliest-starting event gets it).
 * HOLDs count as held, not booked. Out-of-office reduces capacity.
 */
export function buildTechUtilization(args: {
  events: CalendarEvent[];
  techEmails: readonly string[];
  /** First Monday (YYYY-MM-DD) and number of weeks. */
  fromWeek: string;
  weeks: number;
  /** Also list the booked events per week (the scorecard's click-through). */
  withEvents?: boolean;
}): TechWeek[] {
  const emails = args.techEmails.map((e) => e.toLowerCase());
  const weeks = new Map<string, TechWeek>();
  for (let i = 0; i < args.weeks; i++) {
    const weekStart = addDays(mondayOf(args.fromWeek), i * 7);
    weeks.set(weekStart, {
      weekStart,
      bookedHours: 0,
      byType: { job: 0, assessment: 0, callback: 0, other: 0 },
      heldHours: 0,
      capacityHours: 5 * WORKDAY_HOURS,
      bookedPct: null,
      ...(args.withEvents ? { events: [] } : {}),
    });
  }

  const bookedByDay = new Map<string, Array<[number, number]>>();
  const sorted = [...args.events].sort((a, b) => a.start.localeCompare(b.start));
  for (const e of sorted) {
    if (!isBusyEvent(e, emails)) continue;
    const hold = e.summary.startsWith(HOLD_TITLE_PREFIX);
    const ooo = isTechOutOfOffice(e.summary);
    for (const [day, start, end] of pieces(e)) {
      const w = weeks.get(mondayOf(day));
      if (!w) continue;
      const hours = (end - start) / 60;
      if (ooo) {
        if (weekday(day) % 6 !== 0) w.capacityHours -= Math.min(hours, WORKDAY_HOURS);
      } else if (hold) {
        w.heldHours += hours;
      } else {
        const covered = bookedByDay.get(day) ?? [];
        bookedByDay.set(day, covered);
        const free = claim(covered, start, end) / 60;
        w.bookedHours += free;
        w.byType[typeOf(e)] += free;
        if (w.events && free > 0) w.events.push({ id: e.id, summary: e.summary, day, hours: round1(free) });
      }
    }
  }

  return [...weeks.values()].map((w) => {
    const capacityHours = Math.max(0, w.capacityHours);
    return {
      ...w,
      bookedHours: round1(w.bookedHours),
      heldHours: round1(w.heldHours),
      byType: {
        job: round1(w.byType.job),
        assessment: round1(w.byType.assessment),
        callback: round1(w.byType.callback),
        other: round1(w.byType.other),
      },
      capacityHours,
      bookedPct: capacityHours > 0 ? Math.round((w.bookedHours / capacityHours) * 100) / 100 : null,
    };
  });
}

/** Upcoming weeks (after the one holding `today`) at 75%+ booked: the "booked out" number. */
export function bookedAhead(weeks: TechWeek[], today: string): { full: number; of: number; thisWeek: TechWeek | null } {
  const idx = weeks.findIndex((w, i) => w.weekStart <= today && (weeks[i + 1]?.weekStart ?? '9999') > today);
  const ahead = weeks.slice(idx + 1);
  return { full: ahead.filter((w) => (w.bookedPct ?? 0) >= 0.75).length, of: ahead.length, thisWeek: weeks[idx] ?? null };
}

/** Fetch the calendar window and build: `pastWeeks` back through `futureWeeks` ahead of this week. */
export async function getTechUtilization(
  calendar: GoogleCalendarClient,
  techEmails: readonly string[],
  today: string,
  pastWeeks = 4,
  futureWeeks = 3,
): Promise<TechWeek[]> {
  const fromWeek = addDays(mondayOf(today), -7 * pastWeeks);
  const weeks = pastWeeks + 1 + futureWeeks;
  const events = await calendar.listEvents({
    timeMin: new Date(`${fromWeek}T00:00:00-05:00`).toISOString(),
    timeMax: new Date(`${addDays(fromWeek, weeks * 7)}T00:00:00-05:00`).toISOString(),
    maxResults: 2500,
  });
  return buildTechUtilization({ events, techEmails, fromWeek, weeks });
}
