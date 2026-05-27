'use server';

import { revalidatePath } from 'next/cache';
import { getCalendar } from '@/lib/clients';
import {
  getCompletion,
  setCompletion,
  type CompletionPhoto,
  type CompletionRecord,
  type PaymentStatus,
} from '@/lib/completion';
import { classifyEvent } from '@/lib/event-classification';
import { executePaymentBranch } from '@/lib/payment-branches';

export interface ActionState {
  ok: boolean;
  error?: string;
}

const ALLOWED_PAYMENT: PaymentStatus[] = ['cash', 'check', 'card', 'not_yet_paid'];
// TODO: replace with authenticated session email once magic-link auth ships.
const PLACEHOLDER_EMAIL = 'mike@attackacrack.com';

async function loadEvent(eventId: string) {
  try {
    return await getCalendar().getEvent(eventId);
  } catch {
    return null;
  }
}

/** Step 1: Mike arrives — record the check-in. Works for any event type. */
export async function checkIn(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const eventId = String(formData.get('eventId') || '');
  if (!eventId) return { ok: false, error: 'Missing eventId' };

  const existing = await getCompletion(eventId);
  if (existing) {
    return { ok: false, error: `Already checked in at ${existing.checkedInAt}` };
  }

  const evt = await loadEvent(eventId);
  if (!evt) return { ok: false, error: `Could not load calendar event ${eventId}` };

  // Geo fix is best-effort: client passed it (or didn't). We never block on it.
  const lat = parseFloat(String(formData.get('lat') || ''));
  const lng = parseFloat(String(formData.get('lng') || ''));
  const acc = parseFloat(String(formData.get('accuracy') || ''));
  const geoTakenAt = String(formData.get('geoTakenAt') || '');
  const geoError = String(formData.get('geoError') || '') || undefined;

  const checkInLocation =
    Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(acc) && geoTakenAt
      ? { latitude: lat, longitude: lng, accuracy: acc, takenAt: geoTakenAt }
      : undefined;

  const record: CompletionRecord = {
    eventId,
    eventType: classifyEvent(evt.colorId),
    eventSummary: evt.summary,
    phase: 'checked_in',
    checkedInAt: new Date().toISOString(),
    checkedInByEmail: PLACEHOLDER_EMAIL,
    checkInLocation,
    checkInLocationError: checkInLocation ? undefined : geoError,
    photos: [],
  };
  await setCompletion(record);
  revalidatePath(`/events/${eventId}`);
  return { ok: true };
}

/** Step 2 (jobs only): record the Before photo (already uploaded to Blob). */
export async function submitBeforePhoto(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const eventId = String(formData.get('eventId') || '');
  const url = String(formData.get('photoUrl') || '');
  if (!eventId) return { ok: false, error: 'Missing eventId' };
  if (!url) return { ok: false, error: 'Photo upload incomplete — please retry.' };

  const existing = await getCompletion(eventId);
  if (!existing) return { ok: false, error: 'Not checked in yet.' };
  if (existing.eventType !== 'job') {
    return { ok: false, error: 'Before photo only applies to jobs.' };
  }
  if (existing.phase === 'completed') {
    return { ok: false, error: 'Already completed.' };
  }

  const photo: CompletionPhoto = { url, label: 'before', takenAt: new Date().toISOString() };
  const updated: CompletionRecord = {
    ...existing,
    phase: 'before_photo_taken',
    photos: [...existing.photos.filter((p) => p.label !== 'before'), photo],
  };
  await setCompletion(updated);
  revalidatePath(`/events/${eventId}`);
  return { ok: true };
}

/**
 * Step 3: finalize completion. Records:
 *   - After photo (jobs)    OR    photo (assessments / other)
 *   - Payment status (jobs only, required)
 *   - Optional note
 *
 * NOTE: backend payment branching (QB Payment creation, sendInvoice, alert
 * SMS) is NOT wired here yet — payment status is just recorded. That ships
 * in Step B of the field-app build (apps-field.md Phase 5).
 */
export async function submitCompletion(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const eventId = String(formData.get('eventId') || '');
  const photoUrl = String(formData.get('photoUrl') || '');
  const note = (String(formData.get('note') || '').trim()) || undefined;
  const paymentRaw = String(formData.get('paymentStatus') || '');

  if (!eventId) return { ok: false, error: 'Missing eventId' };
  if (!photoUrl) return { ok: false, error: 'Photo upload incomplete — please retry.' };

  const existing = await getCompletion(eventId);
  if (!existing) return { ok: false, error: 'Not checked in yet.' };
  if (existing.phase === 'completed') return { ok: false, error: 'Already completed.' };

  const isJob = existing.eventType === 'job';
  let paymentStatus: PaymentStatus | undefined;
  if (isJob) {
    if (!ALLOWED_PAYMENT.includes(paymentRaw as PaymentStatus)) {
      return { ok: false, error: 'Please choose a payment status (Cash / Check / Card / Not Yet Paid).' };
    }
    paymentStatus = paymentRaw as PaymentStatus;

    if (!existing.photos.some((p) => p.label === 'before')) {
      return { ok: false, error: 'Before photo missing — please take it first.' };
    }
  }

  // For jobs: run the payment branch BEFORE recording completion. If it
  // fails (no invoice, ambiguity, card-unpaid, QB error), the completion
  // is NOT marked done — the tech sees the error and either retries or
  // escalates to Matt. After photo is already in Blob; harmless if orphaned.
  let linkedInvoiceId: string | undefined;
  let linkedPaymentId: string | null | undefined;
  if (isJob && paymentStatus) {
    const evt = await loadEvent(eventId);
    if (!evt) {
      return { ok: false, error: `Could not reload calendar event ${eventId} to run payment branch.` };
    }
    const outcome = await executePaymentBranch(evt, paymentStatus);
    if (!outcome.ok) {
      return { ok: false, error: outcome.error };
    }
    linkedInvoiceId = outcome.invoiceId;
    linkedPaymentId = outcome.paymentId;
  }

  const newPhoto: CompletionPhoto = {
    url: photoUrl,
    label: isJob ? 'after' : 'photo',
    takenAt: new Date().toISOString(),
  };

  const updated: CompletionRecord = {
    ...existing,
    phase: 'completed',
    photos: [...existing.photos.filter((p) => p.label !== newPhoto.label), newPhoto],
    completedAt: new Date().toISOString(),
    paymentStatus,
    note,
    linkedInvoiceId,
    linkedPaymentId,
  };
  await setCompletion(updated);
  revalidatePath(`/events/${eventId}`);
  return { ok: true };
}
