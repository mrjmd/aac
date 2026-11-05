/**
 * Eastern time (America/New_York): AAC's business day. Every "what day is
 * it", "that day's window" and "Eastern wall clock → instant" goes through
 * here. Never round-trip through `toLocaleString` into `new Date(...)`:
 * that builds a Date whose fields only look Eastern and depends on the
 * server's own zone.
 */

export const EASTERN_TZ = 'America/New_York';

const DAY_MS = 86_400_000;

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: EASTERN_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const OFFSET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TZ, timeZoneName: 'shortOffset' });

/** YYYY-MM-DD in Eastern time for an instant (default now). */
export function easternDate(at: Date | number | string = new Date()): string {
  return DATE_FMT.format(at instanceof Date ? at : new Date(at));
}

/** Minutes after Eastern midnight for an instant. */
export function easternMinuteOfDay(at: Date | number | string): number {
  const [h, m] = TIME_FMT.format(at instanceof Date ? at : new Date(at)).split(':').map(Number);
  return h * 60 + m;
}

/** Eastern UTC offset ("-04:00" EDT / "-05:00" EST) in effect at noon on the date. */
export function easternOffset(dateLabel: string): string {
  const name = OFFSET_FMT.formatToParts(new Date(`${dateLabel}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value; // "GMT-5"
  const hours = Number(name?.match(/GMT([+-]\d+)/)?.[1] ?? -5);
  return `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

/** Eastern UTC offset in effect at an instant ("-04:00" / "-05:00"). */
function offsetAt(at: Date): string {
  const name = OFFSET_FMT.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value; // "GMT-5"
  const hours = Number(name?.match(/GMT([+-]\d+)/)?.[1] ?? -5);
  return `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

/**
 * The whole Eastern day as a calendar query window. Start and end each use
 * their own offset, so the two clock-change days (one 23h, one 25h) are
 * covered midnight to midnight. 04:30Z is just after Eastern midnight in
 * either zone; 03:30Z the next day is just before the following midnight.
 */
export function easternDayRange(dateLabel: string): { timeMin: string; timeMax: string; dateLabel: string } {
  const startOff = offsetAt(new Date(`${dateLabel}T04:30:00Z`));
  const endOff = offsetAt(new Date(`${shiftDate(dateLabel, 1)}T03:30:00Z`));
  return { timeMin: `${dateLabel}T00:00:00${startOff}`, timeMax: `${dateLabel}T23:59:59${endOff}`, dateLabel };
}

/** An Eastern wall-clock time on a date, as an instant. */
export function easternWallTime(dateLabel: string, hour: number, minute = 0): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${dateLabel}T${hh}:${mm}:00${easternOffset(dateLabel)}`);
}

/** Calendar-date arithmetic on YYYY-MM-DD labels (no zone involved). */
export function shiftDate(dateLabel: string, days: number): string {
  return new Date(Date.parse(`${dateLabel}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from date a to date b (YYYY-MM-DD; a longer ISO string uses its date part). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

export function isDateLabel(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** A YYYY-MM-DD label naming a real calendar day ("2026-13-01" and "2026-02-30" don't). */
export function isCalendarDate(s: string): boolean {
  if (!isDateLabel(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
