/**
 * suggestSlot — pure function: pick the next-available calendar slot for
 * a SchedulingDirective, respecting AAC's locked v0 policies.
 *
 * v0 policies (from project_scheduling_v0_policies memory):
 *   - Soft 2 jobs/day target (relaxed if every weekday in the window
 *     already hits cap and no free duration window exists under-cap)
 *   - No Saturdays/Sundays by default
 *   - 21-day lookahead from `now`
 *   - Working hours 08:00–17:00 in America/New_York
 *   - Ignores drive time (v1 concern)
 *   - Refuses multi-day predictions (returns null with reasoning)
 *
 * Pure. No I/O. Caller fetches Calendar events and passes them in.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { SchedulingDirective } from './types.js';
import { isManualSchedule } from './types.js';

// ── Policy ─────────────────────────────────────────────────────────

export interface SuggestSlotPolicy {
  timezone: string;
  workStartHour: number;
  workEndHour: number;
  softJobCap: number;
  lookaheadDays: number;
  skipWeekends: boolean;
  defaultAssessmentHours: number;
  defaultJobHours: number;
  /** Earliest day offset from `now` to consider. Default 1 = start tomorrow. */
  earliestDayOffset: number;
  /** Google Calendar colorId counted toward the soft job cap. */
  jobColorId: string;
}

export const DEFAULT_POLICY: SuggestSlotPolicy = {
  timezone: 'America/New_York',
  workStartHour: 8,
  workEndHour: 17,
  softJobCap: 2,
  lookaheadDays: 21,
  skipWeekends: true,
  defaultAssessmentHours: 1,
  defaultJobHours: 2,
  earliestDayOffset: 1,
  jobColorId: '10',
};

// ── I/O shapes ─────────────────────────────────────────────────────

export interface SuggestSlotInput {
  directive: SchedulingDirective;
  existingEvents: readonly CalendarEvent[];
  now: Date;
  policy?: Partial<SuggestSlotPolicy>;
}

export type DurationSource =
  | 'prediction'
  | 'known_slot'
  | 'assessment_default'
  | 'job_default';

export interface SuggestSlotResult {
  slot: { startIso: string; endIso: string } | null;
  reasoning: string;
  daysConsidered: number;
  durationHours: number;
  durationSource: DurationSource;
  /** True when the chosen day already had >= softJobCap existing jobs. */
  exceededSoftCap: boolean;
}

// ── Public function ────────────────────────────────────────────────

export function suggestSlot(input: SuggestSlotInput): SuggestSlotResult {
  const policy: SuggestSlotPolicy = { ...DEFAULT_POLICY, ...input.policy };
  const { directive, existingEvents, now } = input;

  // Manual schedule with an extracted slot bypasses the search entirely.
  if (isManualSchedule(directive) && directive.knownSlot) {
    const duration = resolveDuration(directive, policy).hours;
    const startIso = directive.knownSlot.startIso;
    const endIso = directive.knownSlot.endIso ?? addHoursIso(startIso, duration);
    return {
      slot: { startIso, endIso },
      reasoning: `known slot from manual_schedule directive (${duration}h)`,
      daysConsidered: 0,
      durationHours: duration,
      durationSource: 'known_slot',
      exceededSoftCap: false,
    };
  }

  const { hours: durationHours, source: durationSource } =
    resolveDuration(directive, policy);

  if (directive.durationPrediction?.isMultiDay) {
    return {
      slot: null,
      reasoning: `multi-day scope (${directive.durationPrediction.workdayCount ?? '?'} workdays); v0 suggests single-day slots only`,
      daysConsidered: 0,
      durationHours,
      durationSource,
      exceededSoftCap: false,
    };
  }

  const days: string[] = [];
  for (
    let i = policy.earliestDayOffset;
    i < policy.earliestDayOffset + policy.lookaheadDays;
    i++
  ) {
    const candidate = addDays(now, i);
    if (policy.skipWeekends && isWeekend(candidate, policy.timezone)) continue;
    days.push(localDateKey(candidate, policy.timezone));
  }

  // Two-pass: respect soft cap first, then relax.
  for (const allowOverCap of [false, true] as const) {
    for (const dayKey of days) {
      const found = findSlotOnDay(dayKey, durationHours, existingEvents, policy, allowOverCap);
      if (found) {
        return {
          slot: found,
          reasoning: allowOverCap
            ? `first ${durationHours}h gap on ${dayKey}; relaxed soft cap of ${policy.softJobCap} jobs/day (no under-cap day in window had a free window)`
            : `first ${durationHours}h gap on ${dayKey} within ${pad(policy.workStartHour)}:00–${pad(policy.workEndHour)}:00`,
          daysConsidered: days.length,
          durationHours,
          durationSource,
          exceededSoftCap: allowOverCap,
        };
      }
    }
  }

  const lastDay = days[days.length - 1] ?? '(no eligible days)';
  return {
    slot: null,
    reasoning: `fully booked through ${lastDay}: ${days.length} eligible weekday(s) scanned, no ${durationHours}h window free`,
    daysConsidered: days.length,
    durationHours,
    durationSource,
    exceededSoftCap: false,
  };
}

// ── Internals ──────────────────────────────────────────────────────

function resolveDuration(
  directive: SchedulingDirective,
  policy: SuggestSlotPolicy,
): { hours: number; source: DurationSource } {
  const point = directive.durationPrediction?.point;
  if (point != null && point > 0) return { hours: point, source: 'prediction' };
  if (directive.eventClass === 'assessment') {
    return { hours: policy.defaultAssessmentHours, source: 'assessment_default' };
  }
  return { hours: policy.defaultJobHours, source: 'job_default' };
}

function findSlotOnDay(
  dayKey: string,
  durationHours: number,
  events: readonly CalendarEvent[],
  policy: SuggestSlotPolicy,
  allowOverCap: boolean,
): { startIso: string; endIso: string } | null {
  const dayStartMs = new Date(
    isoAtLocalHour(dayKey, policy.workStartHour, 0, policy.timezone),
  ).getTime();
  const dayEndMs = new Date(
    isoAtLocalHour(dayKey, policy.workEndHour, 0, policy.timezone),
  ).getTime();

  const dayEvents = events
    .map((e) => ({
      startMs: new Date(e.start).getTime(),
      endMs: new Date(e.end).getTime(),
      colorId: e.colorId ?? '',
    }))
    .filter((e) => e.endMs > dayStartMs && e.startMs < dayEndMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (!allowOverCap) {
    const jobsToday = dayEvents.filter((e) => e.colorId === policy.jobColorId).length;
    if (jobsToday >= policy.softJobCap) return null;
  }

  const durationMs = durationHours * 3_600_000;
  let cursor = dayStartMs;
  for (const e of dayEvents) {
    const eventStart = Math.max(e.startMs, dayStartMs);
    if (eventStart - cursor >= durationMs) {
      return {
        startIso: new Date(cursor).toISOString(),
        endIso: new Date(cursor + durationMs).toISOString(),
      };
    }
    cursor = Math.max(cursor, Math.min(e.endMs, dayEndMs));
  }
  if (dayEndMs - cursor >= durationMs) {
    return {
      startIso: new Date(cursor).toISOString(),
      endIso: new Date(cursor + durationMs).toISOString(),
    };
  }
  return null;
}

// ── Timezone + date helpers ────────────────────────────────────────

function addHoursIso(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function localDateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function isWeekend(d: Date, tz: string): boolean {
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(d);
  const dow = WEEKDAY_INDEX[short] ?? 0;
  return dow === 0 || dow === 6;
}

/**
 * Given a local date (YYYY-MM-DD) and a local clock time in `tz`, return the
 * corresponding UTC ISO string. Handles DST transitions correctly because the
 * timezone offset is resolved against an actual instant.
 */
function isoAtLocalHour(
  dayKey: string,
  hour: number,
  minute: number,
  tz: string,
): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const offsetMin = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60_000).toISOString();
}

/**
 * Returns the offset (in minutes) such that `localClock = utcClock + offset`.
 * EDT (UTC-4) → -240, EST (UTC-5) → -300.
 */
function tzOffsetMinutes(utc: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(utc);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '0';
  const rawHour = get('hour');
  const hour = rawHour === '24' ? 0 : parseInt(rawHour, 10);
  const localAsUtc = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    hour,
    parseInt(get('minute'), 10),
    parseInt(get('second'), 10),
  );
  return Math.round((localAsUtc - utc.getTime()) / 60_000);
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
