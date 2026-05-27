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

export interface CompletionRecord {
  eventId: string;
  eventType: 'job' | 'assessment' | 'other';
  eventSummary: string;
  phase: Phase;
  checkedInAt: string;
  checkedInByEmail: string;
  photos: CompletionPhoto[];
  completedAt?: string;
  paymentStatus?: PaymentStatus;
  note?: string;
}

export async function getCompletion(eventId: string): Promise<CompletionRecord | null> {
  const raw = await getRedis().get<CompletionRecord>(keys.fieldCompletion(eventId));
  return raw ?? null;
}

export async function setCompletion(record: CompletionRecord): Promise<void> {
  await getRedis().set(keys.fieldCompletion(record.eventId), record);
}
