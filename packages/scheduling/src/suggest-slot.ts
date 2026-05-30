/**
 * suggestSlot — pick the next-available calendar slot for a SchedulingDirective,
 * respecting AAC's locked v0 policies and (Walk #6.5) drive-time feasibility.
 *
 * v0 policies (from project_scheduling_v0_policies memory):
 *   - Soft 2 jobs/day target (relaxed if every weekday in the window
 *     already hits cap and no free duration window exists under-cap)
 *   - No Saturdays/Sundays by default
 *   - 21-day lookahead from `now`
 *   - Working hours 08:00–17:00 in America/New_York
 *   - Refuses multi-day predictions (returns null with reasoning)
 *
 * Walk #6.5 additions:
 *   - Travel-time aware: when `customerAddress` and `travel` deps are passed,
 *     each candidate gap is feasibility-checked with Distance-Matrix drives
 *     into and back out of the customer site.
 *   - Hard return-home anchor: the tech must be back at `travel.homeAddress`
 *     by `homeReturnDeadlineHour` (default 17:30 ET). The last gap of the
 *     day is bounded by this anchor instead of `workEndHour`.
 *   - Travel buffer: `travelBufferMinutes` of setup/intro slack is added on
 *     each leg.
 *   - Fail-closed: Maps returning null for any leg skips that gap.
 *   - Fall back to the no-travel path (sync-equivalent) when either dep is
 *     missing, so non-travel callers (e.g. assessment with no address) still
 *     get a usable slot.
 *
 * Caller fetches Calendar events and passes them in. Travel deps are
 * injected — no I/O at module load.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { createLogger } from '@aac/shared-utils/logger';
import type { SchedulingDirective } from './types.js';
import { isManualSchedule } from './types.js';
import type { TravelLeg } from './travel-time.js';

const log = createLogger('scheduling-suggest-slot');

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
  /**
   * Latest local-time clock hour at which the tech must be back at home
   * (decimal hours; 17.5 = 5:30 PM). Used as the day's right boundary on
   * the travel-aware path.
   */
  homeReturnDeadlineHour: number;
  /** Setup/intro slack added to each travel leg (in minutes). */
  travelBufferMinutes: number;
}

export const DEFAULT_POLICY: SuggestSlotPolicy = {
  timezone: 'America/New_York',
  workStartHour: 8,
  workEndHour: 17,
  softJobCap: 2,
  lookaheadDays: 21,
  skipWeekends: true,
  defaultAssessmentHours: 0.5,
  defaultJobHours: 2,
  earliestDayOffset: 1,
  jobColorId: '10',
  homeReturnDeadlineHour: 17.5,
  travelBufferMinutes: 15,
};

// ── I/O shapes ─────────────────────────────────────────────────────

export interface SuggestSlotTravelDeps {
  /**
   * Resolve a single drive estimate. Caller decides whether to cache.
   * Returns null when Maps can't compute (typo, unreachable, API failure) —
   * the slot search treats null as "unknown, fail closed for this gap".
   */
  getLeg: (
    origin: string,
    destination: string,
    departureTime: Date,
  ) => Promise<TravelLeg | null>;
  /** Home address — bookend for the first/last gap of each day. */
  homeAddress: string;
}

export interface SuggestSlotInput {
  directive: SchedulingDirective;
  existingEvents: readonly CalendarEvent[];
  now: Date;
  policy?: Partial<SuggestSlotPolicy>;
  /** Customer site address. Required for travel-aware path; falls back to v0 when null/empty. */
  customerAddress?: string | null;
  /** Travel deps. When omitted, the search runs in v0 (no-travel) mode. */
  travel?: SuggestSlotTravelDeps;
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
  /** True when the search used the travel-aware path. False on v0 fallback. */
  travelAware: boolean;
}

// ── Public function ────────────────────────────────────────────────

export async function suggestSlot(input: SuggestSlotInput): Promise<SuggestSlotResult> {
  const policy: SuggestSlotPolicy = { ...DEFAULT_POLICY, ...input.policy };
  const { directive, existingEvents, now, customerAddress, travel } = input;

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
      travelAware: false,
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
      travelAware: false,
    };
  }

  const trimmedAddress = customerAddress?.trim() ?? '';
  const travelEnabled = !!travel && trimmedAddress.length > 0;
  if (!travelEnabled && travel && trimmedAddress.length === 0) {
    log.warn('Travel deps provided but no customerAddress — falling back to v0 (no drive-time check)', {
      directiveId: directive.id,
    });
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
      const found = travelEnabled
        ? await findSlotOnDayWithTravel(
            dayKey,
            durationHours,
            trimmedAddress,
            existingEvents,
            policy,
            allowOverCap,
            travel!,
          )
        : findSlotOnDay(dayKey, durationHours, existingEvents, policy, allowOverCap);
      if (found) {
        const baseReasoning = found.reasoning ?? (allowOverCap
          ? `first ${durationHours}h gap on ${dayKey}; relaxed soft cap of ${policy.softJobCap} jobs/day (no under-cap day in window had a free window)`
          : `first ${durationHours}h gap on ${dayKey} within ${pad(policy.workStartHour)}:00–${pad(policy.workEndHour)}:00`);
        const capSuffix = allowOverCap && found.reasoning
          ? ` (relaxed soft cap of ${policy.softJobCap} jobs/day)`
          : '';
        return {
          slot: { startIso: found.startIso, endIso: found.endIso },
          reasoning: baseReasoning + capSuffix,
          daysConsidered: days.length,
          durationHours,
          durationSource,
          exceededSoftCap: allowOverCap,
          travelAware: travelEnabled,
        };
      }
    }
  }

  const lastDay = days[days.length - 1] ?? '(no eligible days)';
  return {
    slot: null,
    reasoning: `fully booked through ${lastDay}: ${days.length} eligible weekday(s) scanned, no ${durationHours}h window free${travelEnabled ? ' that respects drive time to/from the customer site' : ''}`,
    daysConsidered: days.length,
    durationHours,
    durationSource,
    exceededSoftCap: false,
    travelAware: travelEnabled,
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

interface DayFitResult {
  startIso: string;
  endIso: string;
  /** Travel-aware path supplies a reasoning string with leg minutes. */
  reasoning?: string;
}

function findSlotOnDay(
  dayKey: string,
  durationHours: number,
  events: readonly CalendarEvent[],
  policy: SuggestSlotPolicy,
  allowOverCap: boolean,
): DayFitResult | null {
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

/**
 * Travel-aware day search.
 *
 * Synthesizes "home" fences at both ends of the day, then walks each gap
 * between consecutive fences (home → first event, between events, last
 * event → home). For each gap:
 *   prev_location = previous fence's location (HOME or previous event)
 *   next_location = next fence's location (HOME or next event)
 *   leg_to    = drive(prev_location → customer, departing prev.end)
 *   slot_start = (prev=home) workStart + leg_to
 *                else        max(workStart, prev.end + leg_to + buffer)
 *   slot_end   = slot_start + duration
 *   leg_back  = drive(customer → next_location, departing slot_end)
 *   arrivalAtNext = slot_end + leg_back + buffer
 *   feasible IFF arrivalAtNext ≤ next.start
 *
 * `next.start` for the last fence is `homeReturnDeadlineHour` — hard
 * anchor regardless of `workEndHour`.
 */
async function findSlotOnDayWithTravel(
  dayKey: string,
  durationHours: number,
  customerAddress: string,
  events: readonly CalendarEvent[],
  policy: SuggestSlotPolicy,
  allowOverCap: boolean,
  travel: SuggestSlotTravelDeps,
): Promise<DayFitResult | null> {
  const dayStartMs = new Date(
    isoAtLocalHour(dayKey, policy.workStartHour, 0, policy.timezone),
  ).getTime();
  const deadlineHour = Math.floor(policy.homeReturnDeadlineHour);
  const deadlineMin = Math.round((policy.homeReturnDeadlineHour - deadlineHour) * 60);
  const homeDeadlineMs = new Date(
    isoAtLocalHour(dayKey, deadlineHour, deadlineMin, policy.timezone),
  ).getTime();

  const dayEvents = events
    .map((e) => ({
      startMs: new Date(e.start).getTime(),
      endMs: new Date(e.end).getTime(),
      colorId: e.colorId ?? '',
      location: (e.location ?? '').trim(),
    }))
    .filter((e) => e.endMs > dayStartMs && e.startMs < homeDeadlineMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (!allowOverCap) {
    const jobsToday = dayEvents.filter((e) => e.colorId === policy.jobColorId).length;
    if (jobsToday >= policy.softJobCap) return null;
  }

  const durationMs = durationHours * 3_600_000;
  const bufferMs = policy.travelBufferMinutes * 60_000;
  const homeAddr = travel.homeAddress;

  interface Fence {
    location: string;
    /** End of the prior event (or workStart for the synthetic home anchor). */
    endMs: number;
    /** Start of this event (or homeDeadline for the synthetic home anchor). */
    startMs: number;
    isHome: boolean;
  }
  const fences: Fence[] = [
    { location: homeAddr, endMs: dayStartMs, startMs: dayStartMs, isHome: true },
    ...dayEvents.map((e) => ({
      location: e.location || homeAddr,
      endMs: e.endMs,
      startMs: e.startMs,
      isHome: false,
    })),
    { location: homeAddr, endMs: homeDeadlineMs, startMs: homeDeadlineMs, isHome: true },
  ];

  for (let i = 0; i < fences.length - 1; i++) {
    const prev = fences[i];
    const next = fences[i + 1];

    // Overlapping / back-to-back events: no gap to evaluate.
    if (next.startMs <= prev.endMs) continue;

    // Drive into the customer site.
    const legTo = await travel.getLeg(
      prev.location,
      customerAddress,
      new Date(prev.endMs),
    );
    if (!legTo) {
      log.warn('travel-aware: inbound leg unavailable, skipping gap', {
        dayKey,
        gapIndex: i,
        prevLocation: prev.location,
        customerAddress,
      });
      continue;
    }
    const legToMs = legTo.durationSec * 1000;

    let earliestStart: number;
    if (prev.isHome) {
      // Mike leaves home around workStart; arrives at customer workStart + drive.
      earliestStart = dayStartMs + legToMs;
    } else {
      earliestStart = Math.max(dayStartMs, prev.endMs + legToMs + bufferMs);
    }
    const slotEnd = earliestStart + durationMs;

    if (slotEnd > homeDeadlineMs) continue;

    // Drive out toward whatever comes next (real event or home).
    const legBack = await travel.getLeg(
      customerAddress,
      next.location,
      new Date(slotEnd),
    );
    if (!legBack) {
      log.warn('travel-aware: outbound leg unavailable, skipping gap', {
        dayKey,
        gapIndex: i,
        customerAddress,
        nextLocation: next.location,
      });
      continue;
    }

    const arrivalAtNext = slotEnd + legBack.durationSec * 1000 + bufferMs;
    if (arrivalAtNext > next.startMs) continue;

    const legToMin = Math.round(legTo.durationSec / 60);
    const legBackMin = Math.round(legBack.durationSec / 60);
    const fromLabel = prev.isHome ? 'home' : 'previous job';
    const toLabel = next.isHome ? 'home (back by deadline)' : 'next event';
    return {
      startIso: new Date(earliestStart).toISOString(),
      endIso: new Date(slotEnd).toISOString(),
      reasoning: `${dayKey}: ${fromLabel} → customer ${legToMin}min, ${durationHours}h on-site, customer → ${toLabel} ${legBackMin}min (+${policy.travelBufferMinutes}min buffer each leg)`,
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
