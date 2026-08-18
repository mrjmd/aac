'use server';

import { del } from '@vercel/blob';
import { revalidatePath } from 'next/cache';
import { createLogger } from '@aac/shared-utils/logger';
import { getCalendar } from '@/lib/clients';
import {
  getCompletion,
  setCompletion,
  type CompletionEdit,
  type CompletionPhoto,
  type CompletionRecord,
  type PaymentStatus,
} from '@/lib/completion';
import { classifyEvent } from '@/lib/event-classification';
import {
  bucketAllowsCancellation,
  bucketAllowsCheckIn,
  bucketForEvent,
  daysLate,
} from '@/lib/event-time-bucket';
import { executePaymentBranch } from '@/lib/payment-branches';
import { getCurrentSession } from '@/lib/session';

const log = createLogger('field:event-actions');

export interface ActionState {
  ok: boolean;
  error?: string;
}

const ALLOWED_PAYMENT: PaymentStatus[] = ['cash', 'check', 'card', 'not_yet_paid'];

async function loadEvent(eventId: string) {
  try {
    return await getCalendar().getEvent(eventId);
  } catch {
    return null;
  }
}

/** Step 1: Mike arrives — record the check-in. Works for any event type. */
export async function checkIn(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('checkIn rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  if (!eventId) {
    log.warn('checkIn rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }

  const existing = await getCompletion(eventId);
  if (existing) {
    log.warn('checkIn rejected: already checked in', {
      eventId,
      email: session.email,
      checkedInAt: existing.checkedInAt,
    });
    return { ok: false, error: `Already checked in at ${existing.checkedInAt}` };
  }

  const evt = await loadEvent(eventId);
  if (!evt) {
    log.error('checkIn failed: could not load calendar event', undefined, {
      eventId,
      email: session.email,
    });
    return { ok: false, error: `Could not load calendar event ${eventId}` };
  }

  const bucket = bucketForEvent(evt.start, existing);
  if (!bucketAllowsCheckIn(bucket)) {
    log.warn('checkIn rejected: bucket disallows', {
      eventId,
      email: session.email,
      bucket,
      eventStart: evt.start,
    });
    const msg =
      bucket === 'future'
        ? 'This job is in the future. Check in on the day of the job.'
        : bucket === 'cancelled'
          ? 'This job was cancelled.'
          : 'This job is already completed.';
    return { ok: false, error: msg };
  }

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
    checkedInByEmail: session.email,
    checkInLocation,
    checkInLocationError: checkInLocation ? undefined : geoError,
    photos: [],
  };
  await setCompletion(record);
  revalidatePath(`/events/${eventId}`);
  log.info('checkIn ok', {
    eventId,
    email: session.email,
    eventType: record.eventType,
    eventSummary: record.eventSummary,
    geoFix: Boolean(checkInLocation),
  });
  return { ok: true };
}

/** Step 2 (jobs only): record the Before photo (already uploaded to Blob). */
export async function submitBeforePhoto(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('submitBeforePhoto rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  const url = String(formData.get('photoUrl') || '');
  if (!eventId) {
    log.warn('submitBeforePhoto rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }
  if (!url) {
    log.warn('submitBeforePhoto rejected: missing photoUrl', { eventId, email: session.email });
    return { ok: false, error: 'Photo upload incomplete — please retry.' };
  }

  const existing = await getCompletion(eventId);
  if (!existing) {
    log.warn('submitBeforePhoto rejected: not checked in', { eventId, email: session.email });
    return { ok: false, error: 'Not checked in yet.' };
  }
  if (existing.eventType !== 'repair') {
    log.warn('submitBeforePhoto rejected: not a repair', {
      eventId,
      email: session.email,
      eventType: existing.eventType,
    });
    return { ok: false, error: 'Before photo only applies to repairs.' };
  }
  if (existing.phase === 'completed') {
    log.warn('submitBeforePhoto rejected: already completed', { eventId, email: session.email });
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
  log.info('submitBeforePhoto ok', { eventId, email: session.email, photoUrl: url });
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
  const session = await getCurrentSession();
  if (!session) {
    log.warn('submitCompletion rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  const photoUrl = String(formData.get('photoUrl') || '');
  const note = (String(formData.get('note') || '').trim()) || undefined;
  const paymentRaw = String(formData.get('paymentStatus') || '');

  if (!eventId) {
    log.warn('submitCompletion rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }
  if (!photoUrl) {
    log.warn('submitCompletion rejected: missing photoUrl', { eventId, email: session.email });
    return { ok: false, error: 'Photo upload incomplete — please retry.' };
  }

  const existing = await getCompletion(eventId);
  if (!existing) {
    log.warn('submitCompletion rejected: not checked in', { eventId, email: session.email });
    return { ok: false, error: 'Not checked in yet.' };
  }
  if (existing.phase === 'completed') {
    log.warn('submitCompletion rejected: already completed', { eventId, email: session.email });
    return { ok: false, error: 'Already completed.' };
  }
  if (existing.phase === 'cancelled') {
    log.warn('submitCompletion rejected: cancelled', { eventId, email: session.email });
    return { ok: false, error: 'This job was cancelled.' };
  }

  const isRepair = existing.eventType === 'repair';
  let paymentStatus: PaymentStatus | undefined;
  if (isRepair) {
    if (!ALLOWED_PAYMENT.includes(paymentRaw as PaymentStatus)) {
      log.warn('submitCompletion rejected: invalid payment status', {
        eventId,
        email: session.email,
        paymentRaw,
      });
      return { ok: false, error: 'Please choose a payment status (Cash / Check / Card / Not Yet Paid).' };
    }
    paymentStatus = paymentRaw as PaymentStatus;

    if (!existing.photos.some((p) => p.label === 'before')) {
      log.warn('submitCompletion rejected: before photo missing', { eventId, email: session.email });
      return { ok: false, error: 'Before photo missing — please take it first.' };
    }
  }

  // Reload the event so we can (a) compute days-late and (b) feed the
  // payment branch its calendar context. Required regardless of repair vs
  // non-repair so loggedLateBy lands consistently.
  const evt = await loadEvent(eventId);
  if (!evt) {
    log.error('submitCompletion failed: could not reload event', undefined, {
      eventId,
      email: session.email,
    });
    return { ok: false, error: `Could not reload calendar event ${eventId}.` };
  }
  const lateDays = daysLate(evt.start);

  // For repairs: run the payment branch BEFORE recording completion. If it
  // fails (no invoice, ambiguity, card-unpaid, QB error), the completion
  // is NOT marked done — the tech sees the error and either retries or
  // escalates to Matt. After photo is already in Blob; harmless if orphaned.
  let linkedInvoiceId: string | undefined;
  let linkedPaymentId: string | null | undefined;
  if (isRepair && paymentStatus) {
    const outcome = await executePaymentBranch(evt, paymentStatus);
    if (!outcome.ok) {
      log.warn('submitCompletion rejected: payment branch failed', {
        eventId,
        email: session.email,
        paymentStatus,
        branchError: outcome.error,
      });
      return { ok: false, error: outcome.error };
    }
    linkedInvoiceId = outcome.invoiceId;
    linkedPaymentId = outcome.paymentId;
  }

  const newPhoto: CompletionPhoto = {
    url: photoUrl,
    label: isRepair ? 'after' : 'photo',
    takenAt: new Date().toISOString(),
  };

  // Optional extras: any number of paired (url, kind) entries posted as
  // extraUrl / extraKind. Each tech-uploaded item already lives in Blob;
  // here we just attach its URL + kind onto the record.
  const extraUrls = formData.getAll('extraUrl').map(String).filter(Boolean);
  const extraKinds = formData.getAll('extraKind').map(String);
  const nowIso = new Date().toISOString();
  const extras: CompletionPhoto[] = extraUrls.map((url, i) => ({
    url,
    label: 'extra',
    takenAt: nowIso,
    kind: extraKinds[i] === 'video' ? 'video' : 'image',
  }));

  const updated: CompletionRecord = {
    ...existing,
    phase: 'completed',
    photos: [
      // Keep the Before photo on repairs; replace the main After/photo;
      // drop and re-add extras (so re-submitting doesn't double them).
      ...existing.photos.filter((p) => p.label !== newPhoto.label && p.label !== 'extra'),
      newPhoto,
      ...extras,
    ],
    completedAt: new Date().toISOString(),
    paymentStatus,
    note,
    linkedInvoiceId,
    linkedPaymentId,
    loggedLateBy: lateDays > 0 ? lateDays : undefined,
  };
  await setCompletion(updated);
  revalidatePath(`/events/${eventId}`);
  log.info('submitCompletion ok', {
    eventId,
    email: session.email,
    eventType: updated.eventType,
    paymentStatus,
    photoCount: updated.photos.length,
    extraCount: extras.length,
    linkedInvoiceId,
    linkedPaymentId,
    hasNote: Boolean(note),
    loggedLateBy: updated.loggedLateBy,
  });
  return { ok: true };
}

function withEdit(record: CompletionRecord, edit: CompletionEdit): CompletionRecord {
  return { ...record, edits: [...(record.edits ?? []), edit] };
}

/**
 * Add photos/videos to an already-completed record. Files are already in
 * Blob (client-direct upload); this attaches their URLs and stamps the
 * edit trail. Pre-completion additions go through the normal flow instead.
 */
export async function addPhotos(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('addPhotos rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  if (!eventId) {
    log.warn('addPhotos rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }

  const urls = formData.getAll('photoUrl').map(String).filter(Boolean);
  const kinds = formData.getAll('photoKind').map(String);
  if (urls.length === 0) {
    log.warn('addPhotos rejected: no photos', { eventId, email: session.email });
    return { ok: false, error: 'Photo upload incomplete — please retry.' };
  }

  const existing = await getCompletion(eventId);
  if (!existing || existing.phase !== 'completed') {
    log.warn('addPhotos rejected: not completed', {
      eventId,
      email: session.email,
      phase: existing?.phase ?? null,
    });
    return { ok: false, error: 'This job is not completed yet — use the completion flow to add photos.' };
  }

  const nowIso = new Date().toISOString();
  const known = new Set(existing.photos.map((p) => p.url));
  const additions: CompletionPhoto[] = urls
    .map((url, i): CompletionPhoto => ({
      url,
      label: 'extra',
      takenAt: nowIso,
      kind: kinds[i] === 'video' ? 'video' : 'image',
    }))
    .filter((p) => !known.has(p.url));

  let updated: CompletionRecord = { ...existing, photos: [...existing.photos, ...additions] };
  for (const p of additions) {
    updated = withEdit(updated, { at: nowIso, byEmail: session.email, action: 'photo_added', detail: p.url });
  }
  await setCompletion(updated);
  revalidatePath(`/events/${eventId}`);
  log.info('addPhotos ok', {
    eventId,
    email: session.email,
    added: additions.length,
    photoCount: updated.photos.length,
  });
  return { ok: true };
}

/**
 * Delete one photo from the record, by Blob URL.
 *
 * Before completion: deleting the required Before photo reverts the phase
 * back to checked_in so the flow re-prompts for it.
 * After completion: any photo is deletable EXCEPT the last one — a
 * completed job must keep at least one photo (that requirement is the
 * accountability mechanism). The Blob object is deleted best-effort; the
 * record (with the URL preserved in the edit trail) is the source of truth.
 */
export async function deletePhoto(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('deletePhoto rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  const url = String(formData.get('photoUrl') || '');
  if (!eventId || !url) {
    log.warn('deletePhoto rejected: missing params', { eventId, email: session.email });
    return { ok: false, error: 'Missing eventId or photoUrl' };
  }

  const existing = await getCompletion(eventId);
  if (!existing) {
    log.warn('deletePhoto rejected: no record', { eventId, email: session.email });
    return { ok: false, error: 'Nothing recorded for this job yet.' };
  }
  const target = existing.photos.find((p) => p.url === url);
  if (!target) {
    log.warn('deletePhoto rejected: url not on record', { eventId, email: session.email });
    return { ok: false, error: 'That photo is no longer on this job.' };
  }

  const completed = existing.phase === 'completed';
  if (completed && existing.photos.length === 1) {
    log.warn('deletePhoto rejected: last photo on completed job', { eventId, email: session.email });
    return { ok: false, error: 'A completed job needs at least one photo — add a replacement first, then delete this one.' };
  }

  const nowIso = new Date().toISOString();
  let updated: CompletionRecord = {
    ...existing,
    photos: existing.photos.filter((p) => p.url !== url),
  };
  // Removing the required Before photo mid-flow re-prompts for it.
  if (!completed && target.label === 'before' && updated.phase === 'before_photo_taken') {
    updated = { ...updated, phase: 'checked_in' };
  }
  updated = withEdit(updated, {
    at: nowIso,
    byEmail: session.email,
    action: 'photo_deleted',
    detail: `${target.label}: ${url}`,
  });
  await setCompletion(updated);

  // Blob cleanup is best-effort — the record no longer references the file,
  // and an orphaned blob is harmless. Never fail the action on it.
  try {
    await del(url);
  } catch (err) {
    log.warn('deletePhoto: blob delete failed (orphan left behind)', {
      eventId,
      email: session.email,
      blobError: err instanceof Error ? err.message : String(err),
    });
  }

  revalidatePath(`/events/${eventId}`);
  log.info('deletePhoto ok', {
    eventId,
    email: session.email,
    label: target.label,
    phase: updated.phase,
    photoCount: updated.photos.length,
  });
  return { ok: true };
}

/** Update (or clear) the note on an already-completed record. */
export async function updateNote(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('updateNote rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  if (!eventId) {
    log.warn('updateNote rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }
  const note = String(formData.get('note') || '').trim() || undefined;

  const existing = await getCompletion(eventId);
  if (!existing || existing.phase !== 'completed') {
    log.warn('updateNote rejected: not completed', {
      eventId,
      email: session.email,
      phase: existing?.phase ?? null,
    });
    return { ok: false, error: 'Notes can only be edited after the job is completed.' };
  }
  if ((existing.note ?? undefined) === note) {
    return { ok: true };
  }

  const updated = withEdit(
    { ...existing, note },
    {
      at: new Date().toISOString(),
      byEmail: session.email,
      action: 'note_updated',
      detail: existing.note ? existing.note.slice(0, 500) : undefined,
    },
  );
  await setCompletion(updated);
  revalidatePath(`/events/${eventId}`);
  log.info('updateNote ok', {
    eventId,
    email: session.email,
    hadNote: Boolean(existing.note),
    hasNote: Boolean(note),
  });
  return { ok: true };
}

/**
 * Mark a past-not-completed event as cancelled / not done. Requires a
 * free-text reason. Writes a CompletionRecord with phase='cancelled' so
 * the accountability heuristic (no Mike-owned Drive attachments) excludes
 * this event from the owed-photos list.
 *
 * Allowed only when the event's bucket is past_not_completed. Today's jobs
 * should be completed-or-logged-late; future jobs can't be cancelled in the
 * field app (Matt cancels in Google Calendar).
 */
export async function cancelEvent(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn('cancelEvent rejected: no session');
    return { ok: false, error: 'Signed out — please log in again.' };
  }

  const eventId = String(formData.get('eventId') || '');
  const reason = String(formData.get('reason') || '').trim();

  if (!eventId) {
    log.warn('cancelEvent rejected: missing eventId', { email: session.email });
    return { ok: false, error: 'Missing eventId' };
  }
  if (!reason) {
    log.warn('cancelEvent rejected: missing reason', { eventId, email: session.email });
    return { ok: false, error: 'Please provide a reason for cancelling.' };
  }

  const evt = await loadEvent(eventId);
  if (!evt) {
    log.error('cancelEvent failed: could not load calendar event', undefined, {
      eventId,
      email: session.email,
    });
    return { ok: false, error: `Could not load calendar event ${eventId}.` };
  }

  const existing = await getCompletion(eventId);
  const bucket = bucketForEvent(evt.start, existing);
  if (!bucketAllowsCancellation(bucket)) {
    log.warn('cancelEvent rejected: bucket disallows', {
      eventId,
      email: session.email,
      bucket,
      eventStart: evt.start,
    });
    const msg =
      bucket === 'future'
        ? 'Future jobs are cancelled in Google Calendar, not here.'
        : bucket === 'today'
          ? "Today's jobs can't be cancelled — log a late completion or finish the job."
          : bucket === 'past_completed'
            ? 'This job is already completed.'
            : 'This job was already cancelled.';
    return { ok: false, error: msg };
  }

  const nowIso = new Date().toISOString();
  const record: CompletionRecord = existing
    ? {
        ...existing,
        phase: 'cancelled',
        cancelledAt: nowIso,
        cancelledByEmail: session.email,
        cancellationReason: reason,
      }
    : {
        eventId,
        eventType: classifyEvent(evt.colorId),
        eventSummary: evt.summary,
        phase: 'cancelled',
        // No check-in fields — we synthesize a minimal record. The
        // checkedInAt slot stores the cancellation time so the union
        // type stays satisfied without making fields optional.
        checkedInAt: nowIso,
        checkedInByEmail: session.email,
        photos: [],
        cancelledAt: nowIso,
        cancelledByEmail: session.email,
        cancellationReason: reason,
      };

  await setCompletion(record);
  revalidatePath(`/events/${eventId}`);
  log.info('cancelEvent ok', {
    eventId,
    email: session.email,
    eventType: record.eventType,
    reasonLength: reason.length,
  });
  return { ok: true };
}
