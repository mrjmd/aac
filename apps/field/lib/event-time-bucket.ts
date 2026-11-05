/**
 * Categorize a calendar event into one of five time-relative buckets so
 * the UI + server actions can pick the right behavior.
 *
 *   future              event.start is after end-of-today (ET)
 *   today               event.start falls on today (ET)
 *   past_not_completed  event.start is before today AND no completion / cancellation
 *   past_completed      event.start is before today AND completedAt is set
 *   cancelled           cancelledAt is set (any date)
 *
 * "Today" is computed in America/New_York. Compared as YYYY-MM-DD strings
 * to sidestep DST + UTC-offset edge cases.
 *
 * The bucket is the only signal the UI + server actions trust to decide
 * which flow to render and which actions to permit. Never read event.start
 * directly for control flow — always go through bucketForEvent.
 */

import { easternDate } from '@aac/shared-utils/eastern';

export type EventTimeBucket =
  | 'future'
  | 'today'
  | 'past_not_completed'
  | 'past_completed'
  | 'cancelled';

interface CompletionSignal {
  completedAt?: string;
  cancelledAt?: string;
}

export function bucketForEvent(
  eventStartIso: string,
  completion: CompletionSignal | null | undefined,
): EventTimeBucket {
  if (completion?.cancelledAt) return 'cancelled';

  const today = easternDate();
  const eventDate = easternDate(eventStartIso);

  if (eventDate > today) return 'future';
  if (eventDate === today) return 'today';

  return completion?.completedAt ? 'past_completed' : 'past_not_completed';
}

/** True when this bucket permits photo-upload UI. */
export function bucketAllowsPhotoUpload(bucket: EventTimeBucket): boolean {
  return bucket === 'today' || bucket === 'past_not_completed' || bucket === 'past_completed';
}

/** True when this bucket permits the check-in / completion checklist flow. */
export function bucketAllowsCheckIn(bucket: EventTimeBucket): boolean {
  return bucket === 'today' || bucket === 'past_not_completed';
}

/** True when this bucket permits the "Mark as cancelled / not done" action. */
export function bucketAllowsCancellation(bucket: EventTimeBucket): boolean {
  return bucket === 'past_not_completed';
}

/** Compute days late = today − event date. Returns 0 for same-day or future. */
export function daysLate(eventStartIso: string): number {
  const today = easternDate();
  const eventDate = easternDate(eventStartIso);
  if (eventDate >= today) return 0;
  const [ty, tm, td] = today.split('-').map(Number);
  const [ey, em, ed] = eventDate.split('-').map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const eventUtc = Date.UTC(ey, em - 1, ed);
  return Math.floor((todayUtc - eventUtc) / (24 * 60 * 60 * 1000));
}
