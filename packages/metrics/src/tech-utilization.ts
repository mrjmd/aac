import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { EVENT_CLASS_COLOR_IDS, HOLD_TITLE_PREFIX } from '@aac/scheduling';

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
}

export const WORKDAY_HOURS = 8;
/** One event never counts for more than a long field day. */
const MAX_EVENT_HOURS = 10;

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const NY_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDay = (iso: string) => NY.format(new Date(iso));
/** Minutes after local midnight in America/New_York. */
function nyMinute(iso: string): number {
  const [h, m] = NY_TIME.format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
}
const isAllDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Same test as middleware's isTechOutOfOffice: the tech's name AND an OOO marker. */
function isOutOfOffice(summary: string): boolean {
  return /\bmike\b/i.test(summary) && /\booo\b|out of office/i.test(summary);
}

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
  const start = nyMinute(e.start);
  const lengthMin = Math.min(MAX_EVENT_HOURS * 60, Math.max(0, (Date.parse(e.end) - Date.parse(e.start)) / 60_000));
  return [[nyDay(e.start), start, Math.min(24 * 60, start + lengthMin)]];
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
    });
  }

  const bookedByDay = new Map<string, Array<[number, number]>>();
  const sorted = [...args.events].sort((a, b) => a.start.localeCompare(b.start));
  for (const e of sorted) {
    const hold = e.summary.startsWith(HOLD_TITLE_PREFIX);
    const ooo = isOutOfOffice(e.summary);
    const attends = e.attendees.some((a) => emails.includes(a.toLowerCase()));
    if (!hold && !ooo && !attends) continue;
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
