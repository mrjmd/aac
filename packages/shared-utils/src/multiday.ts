/**
 * Multi-day job detection over Google Calendar events.
 *
 * Multi-day jobs are several green (colorId 10) events for one job, with
 * continuation days conventionally titled "NAME [cont]" at the same
 * location. Nothing in the calendar links them formally, so this module
 * encodes the convention in one place. Consumers: middleware follow-up
 * cron, field app completion flow, triage D1 detector.
 *
 * Design doc: docs/projects/multiday-jobs.md
 *
 * Structural event type only — no dependency on @aac/api-clients. Pass
 * whatever event objects you have; only the listed fields are read.
 */

/** Minimal shape of a calendar event this module needs. */
export interface MultidayEvent {
  id: string;
  summary?: string;
  location?: string;
  /** ISO datetime (or date) of the event start. */
  start: string;
  colorId?: string;
}

/** Green = job. Continuations only make sense between job events. */
const JOB_COLOR_ID = '10';

/**
 * Continuations start within this many days of the prior day's event.
 * Observed gaps are 1–5 days (weekends, weather); 10 gives slack without
 * linking genuinely separate repeat jobs at the same address.
 */
export const CONTINUATION_WINDOW_DAYS = 10;

const DAY_MS = 86_400_000;

/**
 * Title with any trailing bracketed/parenthesized marker stripped,
 * case preserved: "Teddy Watler [cont]" → "Teddy Watler". Use this when
 * the title is a customer name destined for a lookup (Pipedrive, QB)
 * rather than an equality key.
 */
export function stripTitleMarker(summary: string | undefined): string {
  return (summary ?? '')
    .replace(/\s*[[(][^\])]*[\])]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title with any trailing bracketed/parenthesized marker stripped:
 * "Ed Spooner [cont]" → "ed spooner". Lowercased, whitespace collapsed.
 */
export function baseTitle(summary: string | undefined): string {
  return stripTitleMarker(summary).toLowerCase();
}

/**
 * Street line of a location, normalized for equality: everything before
 * the first comma, lowercased, punctuation stripped, whitespace collapsed.
 * "17 Montague Ave, Lake Pleasant, MA 01347, USA" → "17 montague ave".
 */
export function normalizedStreet(location: string | undefined): string {
  return (location ?? '')
    .split(',')[0]
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the next continuation of `event` among `candidates`: a green event
 * that starts later (and within CONTINUATION_WINDOW_DAYS) and matches on
 * base title or normalized street. Returns the earliest such event, or
 * null when `event` is the final (or only) day of its chain.
 *
 * `candidates` may include `event` itself, past events, and non-job
 * events — they are filtered out. Order does not matter.
 */
export function findContinuation<T extends MultidayEvent>(
  event: MultidayEvent,
  candidates: T[],
): T | null {
  if ((event.colorId ?? JOB_COLOR_ID) !== JOB_COLOR_ID) return null;
  const startMs = new Date(event.start).getTime();
  if (Number.isNaN(startMs)) return null;

  const title = baseTitle(event.summary);
  const street = normalizedStreet(event.location);

  let best: T | null = null;
  let bestMs = Infinity;
  for (const c of candidates) {
    if (c.id === event.id) continue;
    // Missing colorId = caller already filtered to job events.
    if ((c.colorId ?? JOB_COLOR_ID) !== JOB_COLOR_ID) continue;
    const cMs = new Date(c.start).getTime();
    if (Number.isNaN(cMs)) continue;
    if (cMs <= startMs || cMs - startMs > CONTINUATION_WINDOW_DAYS * DAY_MS) continue;

    const titleMatch = title !== '' && baseTitle(c.summary) === title;
    const streetMatch = street !== '' && normalizedStreet(c.location) === street;
    if (!titleMatch && !streetMatch) continue;

    if (cMs < bestMs) {
      best = c;
      bestMs = cMs;
    }
  }
  return best;
}

/** True when `event` has a later same-job day — i.e. is NOT the final day. */
export function hasContinuation(event: MultidayEvent, candidates: MultidayEvent[]): boolean {
  return findContinuation(event, candidates) !== null;
}
