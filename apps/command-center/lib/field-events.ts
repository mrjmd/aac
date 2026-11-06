import type { TimelineEvent } from "@aac/customers";
import {
  EVENT_CLASS_COLOR_IDS,
  HOLD_COLOR_ID,
  HOLD_TITLE_PREFIX,
  STUB_TITLE_PREFIX,
  isTechOutOfOffice,
} from "@aac/shared-utils/calendar";
import { EASTERN_TZ, easternDate } from "@aac/shared-utils/eastern";

/** The mockup's calendar dot classes. */
export type FieldClass = "job" | "assess" | "cb" | "stub" | "hold";

export const FIELD_LABEL: Record<FieldClass, string> = {
  job: "Job",
  assess: "Assessment",
  cb: "Callback",
  stub: "Booked (stub)",
  hold: "Hold (offered)",
};

/** Field work by title prefix, then calendar color; null for anything else (Matt's meetings). */
export function fieldClass(ev: Pick<TimelineEvent, "summary" | "colorId">): FieldClass | null {
  if (ev.summary.startsWith(HOLD_TITLE_PREFIX) || ev.colorId === HOLD_COLOR_ID) return "hold";
  if (ev.summary.startsWith(STUB_TITLE_PREFIX)) return "stub";
  switch (ev.colorId) {
    case EVENT_CLASS_COLOR_IDS.job:
      return "job";
    case EVENT_CLASS_COLOR_IDS.assessment:
      return "assess";
    case EVENT_CLASS_COLOR_IDS.callback:
      return "cb";
    default:
      return null;
  }
}

const NY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN_TZ, hour: "numeric", minute: "2-digit" });

/** YYYY-MM-DD in New York; all-day events carry a bare date. */
export const eventDay = (start: string) => (start.length === 10 ? start : easternDate(start));

export interface FieldEvent {
  id: string;
  cls: FieldClass;
  time: string;
  title: string;
  town?: string;
  href: string;
}

/** A day's field events, in start order, as the mockup's job chips. */
export function fieldDay(events: TimelineEvent[], day: string): FieldEvent[] {
  return events
    .filter((e) => eventDay(e.start) === day)
    .map((e) => ({ e, cls: fieldClass(e) }))
    .filter((x): x is { e: TimelineEvent; cls: FieldClass } => x.cls !== null)
    .sort((a, b) => a.e.start.localeCompare(b.e.start))
    .map(({ e, cls }) => ({
      id: e.id,
      cls,
      time: e.start.length === 10 ? "All day" : NY_TIME.format(new Date(e.start)).replace(":00", "").replace(/ (AM|PM)/, ""),
      title: e.summary,
      town: e.location?.split(",").map((s) => s.trim())[1],
      href: e.htmlLink,
    }));
}

/** True when a "Mike OOO" event covers the day (all-day ends are exclusive). */
export function techOut(events: TimelineEvent[], day: string): boolean {
  return events.some((e) => isTechOutOfOffice(e.summary) && eventDay(e.start) <= day && day < (e.end.length === 10 ? e.end : eventDay(e.end) + "~"));
}
