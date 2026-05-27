'use server';

import { put } from '@vercel/blob';
import { revalidatePath } from 'next/cache';
import { getCalendar } from '@/lib/clients';
import { setCompletion, type CompletionPhoto, type PaymentStatus } from '@/lib/completion';
import { classifyEvent } from '@/lib/event-classification';

export interface SubmitState {
  ok: boolean;
  error?: string;
}

const ALLOWED_PAYMENT: PaymentStatus[] = ['cash', 'check', 'card', 'not_yet_paid'];

export async function submitCompletion(
  _prev: SubmitState | null,
  formData: FormData,
): Promise<SubmitState> {
  const eventId = String(formData.get('eventId') || '');
  if (!eventId) return { ok: false, error: 'Missing eventId' };

  let event;
  try {
    event = await getCalendar().getEvent(eventId);
  } catch {
    return { ok: false, error: `Could not load calendar event ${eventId}` };
  }

  const eventType = classifyEvent(event.colorId);
  const note = (String(formData.get('note') || '').trim()) || undefined;
  const paymentRaw = String(formData.get('paymentStatus') || '');
  const paymentStatus =
    eventType === 'job'
      ? (ALLOWED_PAYMENT.includes(paymentRaw as PaymentStatus) ? (paymentRaw as PaymentStatus) : undefined)
      : undefined;

  if (eventType === 'job' && !paymentStatus) {
    return { ok: false, error: 'Please choose a payment status (Cash / Check / Card / Not Yet Paid).' };
  }

  // Photo handling — server-side validation of required count
  const photoFiles: { file: File; label: CompletionPhoto['label'] }[] = [];
  if (eventType === 'job') {
    const before = formData.get('photoBefore');
    const after = formData.get('photoAfter');
    if (!(before instanceof File) || before.size === 0) {
      return { ok: false, error: 'Before photo is required for jobs.' };
    }
    if (!(after instanceof File) || after.size === 0) {
      return { ok: false, error: 'After photo is required for jobs.' };
    }
    photoFiles.push({ file: before, label: 'before' });
    photoFiles.push({ file: after, label: 'after' });
  } else {
    const photo = formData.get('photo');
    if (!(photo instanceof File) || photo.size === 0) {
      return { ok: false, error: 'A photo is required.' };
    }
    photoFiles.push({ file: photo, label: 'photo' });
  }

  // Upload to Vercel Blob
  const ts = Date.now();
  const uploaded: CompletionPhoto[] = [];
  try {
    for (const { file, label } of photoFiles) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `field/${eventId}/${label}-${ts}.${ext}`;
      const blob = await put(path, file, {
        access: 'public',
        contentType: file.type || 'image/jpeg',
        addRandomSuffix: false,
      });
      uploaded.push({ url: blob.url, label });
    }
  } catch (err) {
    console.error('Blob upload failed', err);
    return { ok: false, error: `Photo upload failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Persist completion record
  try {
    await setCompletion({
      eventId,
      eventType,
      eventSummary: event.summary,
      completedAt: new Date().toISOString(),
      // TODO: replace with authenticated user email once magic-link auth ships
      completedByEmail: 'mike@attackacrack.com',
      photos: uploaded,
      paymentStatus,
      note,
    });
  } catch (err) {
    console.error('Completion record save failed', err);
    return { ok: false, error: `Saving completion failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  revalidatePath(`/events/${eventId}`);
  return { ok: true };
}
