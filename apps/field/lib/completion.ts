/**
 * Field completion record — phased state for a calendar event.
 *
 * Backed by Upstash Redis under the key from `@aac/shared-utils/redis`.
 * Authoritative source for where Mike is in the check-in → before → complete flow.
 */

import { keys } from '@aac/shared-utils/redis';
import { getRedis } from './clients';

export type PaymentStatus = 'cash' | 'check' | 'card' | 'not_yet_paid';
export type Phase = 'checked_in' | 'before_photo_taken' | 'completed';

export interface CompletionPhoto {
  url: string;
  label: 'before' | 'after' | 'photo';
  takenAt: string;
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
  eventType: 'job' | 'assessment' | 'other';
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
}

export async function getCompletion(eventId: string): Promise<CompletionRecord | null> {
  const raw = await getRedis().get<CompletionRecord>(keys.fieldCompletion(eventId));
  return raw ?? null;
}

export async function setCompletion(record: CompletionRecord): Promise<void> {
  await getRedis().set(keys.fieldCompletion(record.eventId), record);
}
