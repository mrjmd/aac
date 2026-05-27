/**
 * Field completion record — reads and writes for the per-event completion state.
 *
 * Backed by Upstash Redis under the key from `@aac/shared-utils/redis`.
 * Authoritative source for whether an event has been marked complete and
 * the photos/payment info captured at that time.
 */

import { keys } from '@aac/shared-utils/redis';
import { getRedis } from './clients';

export type PaymentStatus = 'cash' | 'check' | 'card' | 'not_yet_paid';

export interface CompletionPhoto {
  url: string;
  label: 'before' | 'after' | 'photo';
}

export interface CompletionRecord {
  eventId: string;
  eventType: 'job' | 'assessment' | 'other';
  eventSummary: string;
  completedAt: string;       // ISO timestamp
  completedByEmail: string;  // technician email (placeholder until auth lands)
  photos: CompletionPhoto[];
  paymentStatus?: PaymentStatus;
  /** Free-text note from the field, optional */
  note?: string;
}

export async function getCompletion(eventId: string): Promise<CompletionRecord | null> {
  const raw = await getRedis().get<CompletionRecord>(keys.fieldCompletion(eventId));
  return raw ?? null;
}

export async function setCompletion(record: CompletionRecord): Promise<void> {
  await getRedis().set(keys.fieldCompletion(record.eventId), record);
}
