/**
 * Social posting cadence configuration and next-slot finder.
 *
 * v1: hardcoded constant. A future settings UI will replace this with a
 * DB-backed setting; the rest of the system depends only on the public
 * functions exported here, so swapping the source is a one-file change.
 */
import { db } from "@/lib/db";
import { contentPosts } from "@/db/schema";
import { and, isNotNull, inArray } from "drizzle-orm";

/** Day-of-week numbers: Sun=0, Mon=1, ... Sat=6 */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface CadenceConfig {
  daysOfWeek: readonly DayOfWeek[];
  hour: number;
  minute: number;
  /** IANA timezone — slot times are interpreted in this zone */
  timezone: string;
}

export const SOCIAL_CADENCE: CadenceConfig = {
  daysOfWeek: [1, 3, 5], // Mon, Wed, Fri
  hour: 10,
  minute: 0,
  timezone: "America/New_York",
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Compute the next open social posting slot.
 * Walks forward from tomorrow, skipping non-cadence days and dates that
 * already have a scheduled or published social post.
 */
export async function findNextSlot(): Promise<Date> {
  const taken = await getTakenDates();

  // Start from tomorrow in the cadence timezone
  const candidate = new Date();
  candidate.setDate(candidate.getDate() + 1);

  for (let i = 0; i < 90; i++) {
    const dow = dayOfWeekInTz(candidate, SOCIAL_CADENCE.timezone);
    if ((SOCIAL_CADENCE.daysOfWeek as readonly number[]).includes(dow)) {
      const ymd = ymdInTz(candidate, SOCIAL_CADENCE.timezone);
      if (!taken.has(ymd)) {
        return slotAtCadenceTime(candidate);
      }
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  throw new Error("findNextSlot: no open slot in 90 days");
}

// ── Internals ───────────────────────────────────────────────────────

async function getTakenDates(): Promise<Set<string>> {
  const rows = await db
    .select({ scheduledAt: contentPosts.scheduledAt })
    .from(contentPosts)
    .where(
      and(
        isNotNull(contentPosts.scheduledAt),
        inArray(contentPosts.status, ["scheduled", "published"]),
      ),
    );

  const taken = new Set<string>();
  for (const row of rows) {
    if (row.scheduledAt) {
      taken.add(ymdInTz(new Date(row.scheduledAt), SOCIAL_CADENCE.timezone));
    }
  }
  return taken;
}

/** Get the day-of-week (0-6) of a date as it would appear in the given timezone. */
function dayOfWeekInTz(date: Date, timezone: string): DayOfWeek {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const weekday = fmt.format(date);
  const map: Record<string, DayOfWeek> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[weekday] ?? 0;
}

/** Get the YYYY-MM-DD string of a date in the given timezone. */
function ymdInTz(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD format directly
  return fmt.format(date);
}

/**
 * Given a candidate date, return a Date pointing to the cadence hour:minute
 * on that calendar date in the cadence timezone.
 */
function slotAtCadenceTime(candidate: Date): Date {
  const ymd = ymdInTz(candidate, SOCIAL_CADENCE.timezone);
  const [year, month, day] = ymd.split("-").map(Number);

  // Build the target wall-clock time in the cadence timezone, then convert
  // back to a UTC instant by computing the timezone offset for that moment.
  const wallClockUtc = Date.UTC(
    year,
    month - 1,
    day,
    SOCIAL_CADENCE.hour,
    SOCIAL_CADENCE.minute,
    0,
  );

  // Compute offset between UTC and the target timezone for this date.
  // We do this by formatting wallClockUtc as if it were in the target tz
  // and seeing how far off it is from the wall-clock numbers we wanted.
  const offsetMs = getTimezoneOffsetMs(new Date(wallClockUtc), SOCIAL_CADENCE.timezone);
  return new Date(wallClockUtc - offsetMs);
}

/** Returns the offset (in ms) between UTC and the named timezone for a given instant. */
function getTimezoneOffsetMs(instant: Date, timezone: string): number {
  // Format the instant in the target timezone and parse it back as if UTC,
  // then diff. This gives the wall-clock offset for that specific moment
  // (handles DST correctly).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - instant.getTime();
}
