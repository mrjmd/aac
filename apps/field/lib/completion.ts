/**
 * Field completion record — phased state for a calendar event.
 *
 * Backed by Upstash Redis under the key from `@aac/shared-utils/redis`.
 * Authoritative source for where Mike is in the check-in → before → complete flow.
 */

import { keys } from '@aac/shared-utils/redis';
import { getRedis } from './clients';

export type PaymentStatus = 'cash' | 'check' | 'card' | 'not_yet_paid';
export type Phase = 'checked_in' | 'before_photo_taken' | 'completed' | 'cancelled';

/**
 * One uploaded media item attached to a completion.
 *
 *   label='before' — the required Before photo (repairs only)
 *   label='after'  — the required After photo on Mark Complete (repairs)
 *   label='photo'  — the required photo on Mark Complete (non-repairs)
 *   label='extra'  — optional additional media Mike captured at job time
 *
 * `kind` lets the UI render videos as <video> instead of <img>.
 */
export interface CompletionPhoto {
  url: string;
  label: 'before' | 'after' | 'photo' | 'extra';
  takenAt: string;
  kind?: 'image' | 'video';
}

/**
 * One post-submission edit to a completion record. The record's core
 * timestamps (checkedInAt, completedAt) cover the original flow; this
 * trail covers everything that changed after Mark Complete.
 */
export interface CompletionEdit {
  at: string;
  byEmail: string;
  action: 'photo_added' | 'photo_deleted' | 'note_updated';
  /**
   * Audit payload: for photos, the Blob URL (kept even after deletion so
   * the trail survives the cascade); for notes, the previous text.
   */
  detail?: string;
}

export interface GeoCoords {
  /** WGS84 latitude */
  latitude: number;
  /** WGS84 longitude */
  longitude: number;
  /** Accuracy radius in meters (per the W3C Geolocation API). */
  accuracy: number;
  /** ISO timestamp when the fix was taken. */
  takenAt: string;
}

export interface CompletionRecord {
  eventId: string;
  eventType: 'repair' | 'assessment' | 'callback' | 'other';
  eventSummary: string;
  phase: Phase;
  checkedInAt: string;
  checkedInByEmail: string;
  /**
   * GPS fix captured client-side at check-in. Optional because:
   *   - User can deny browser permission
   *   - Indoor / basement signal can fail with no fix
   *   - We never block check-in on geo (trust-but-verify, silent)
   */
  checkInLocation?: GeoCoords;
  /** If geo failed at check-in, the reason (for later analysis). */
  checkInLocationError?: string;
  photos: CompletionPhoto[];
  completedAt?: string;
  paymentStatus?: PaymentStatus;
  note?: string;
  /** QB Invoice the payment branch acted on (all branches set this on success). */
  linkedInvoiceId?: string;
  /** QB Payment ID created by Cash/Check branch (null for Card / Not Yet Paid). */
  linkedPaymentId?: string | null;
  /**
   * Days between event.start and completedAt when Mike logged the job
   * retroactively (event was in the past at submit time). 0 for same-day
   * completions. Absent for never-completed records.
   */
  loggedLateBy?: number;
  /**
   * Multi-day job day-wrap: this event was closed without payment because
   * the job continues on the referenced calendar event (the next day).
   * Payment + invoice happen on the chain's final day only.
   */
  continuedByEventId?: string;
  /** Set when the event is marked cancelled / not done; phase moves to 'cancelled'. */
  cancelledAt?: string;
  cancelledByEmail?: string;
  /** Required free-text reason captured at cancellation. */
  cancellationReason?: string;
  /** Post-submission edits (add/delete photo, note change), oldest first. */
  edits?: CompletionEdit[];
}

export async function getCompletion(eventId: string): Promise<CompletionRecord | null> {
  const raw = await getRedis().get<CompletionRecord>(keys.fieldCompletion(eventId));
  return raw ?? null;
}

export async function setCompletion(record: CompletionRecord): Promise<void> {
  await getRedis().set(keys.fieldCompletion(record.eventId), record);
}
