'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { upload } from '@vercel/blob/client';
import { checkIn, submitBeforePhoto, submitCompletion, type ActionState } from './actions';
import type { CompletionRecord, Phase } from '@/lib/completion';
import type { EventType } from '@/lib/event-classification';

interface Props {
  eventId: string;
  eventType: EventType;
  completion: CompletionRecord | null;
}

export default function CompletionFlow({ eventId, eventType, completion }: Props) {
  const phase: Phase | null = completion?.phase ?? null;

  if (phase === null) {
    return <CheckInStep eventId={eventId} />;
  }
  if (phase === 'checked_in' && eventType === 'job') {
    return <BeforePhotoStep eventId={eventId} checkedInAt={completion!.checkedInAt} />;
  }
  if (phase === 'checked_in' || phase === 'before_photo_taken') {
    return (
      <CompleteStep
        eventId={eventId}
        eventType={eventType}
        completion={completion!}
      />
    );
  }
  return null; // 'completed' is handled by the parent server component
}

// ─── Step 1: Check In ────────────────────────────────────────────────────

function CheckInStep({ eventId }: { eventId: string }) {
  const [state, formAction] = useActionState<ActionState | null, FormData>(checkIn, null);
  const [isPending, startTransition] = useTransition();

  async function handleCheckIn() {
    // Capture a single GPS fix — best-effort, never blocks check-in.
    // 5s timeout, accept cached fixes <60s old.
    const geo = await getGeolocationOnce({ timeoutMs: 5000, maxAgeMs: 60_000 });

    const fd = new FormData();
    fd.set('eventId', eventId);
    if (geo.ok) {
      fd.set('lat', String(geo.coords.latitude));
      fd.set('lng', String(geo.coords.longitude));
      fd.set('accuracy', String(geo.coords.accuracy));
      fd.set('geoTakenAt', new Date().toISOString());
    } else {
      fd.set('geoError', geo.error);
    }

    startTransition(() => formAction(fd));
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600">
        Tap when you arrive at the job site.
      </p>
      <button
        type="button"
        onClick={handleCheckIn}
        disabled={isPending}
        className="w-full py-4 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
      >
        {isPending ? 'Checking in…' : 'Check In'}
      </button>
      <ErrorBox error={state?.error} />
    </div>
  );
}

type GeoResult =
  | { ok: true; coords: { latitude: number; longitude: number; accuracy: number } }
  | { ok: false; error: string };

function getGeolocationOnce({ timeoutMs, maxAgeMs }: { timeoutMs: number; maxAgeMs: number }): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, error: 'Geolocation API not available' });
      return;
    }
    // Safety net: if neither callback fires within the timeout window, resolve
    // anyway so check-in is never blocked.
    const safetyTimer = setTimeout(() => {
      resolve({ ok: false, error: 'Geolocation timed out (safety)' });
    }, timeoutMs + 1000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(safetyTimer);
        resolve({
          ok: true,
          coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          },
        });
      },
      (err) => {
        clearTimeout(safetyTimer);
        const reason =
          err.code === err.PERMISSION_DENIED ? 'permission_denied'
          : err.code === err.POSITION_UNAVAILABLE ? 'position_unavailable'
          : err.code === err.TIMEOUT ? 'timeout'
          : 'unknown';
        resolve({ ok: false, error: reason });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maxAgeMs },
    );
  });
}

// ─── Step 2: Before Photo (jobs only) ────────────────────────────────────

function BeforePhotoStep({ eventId, checkedInAt }: { eventId: string; checkedInAt: string }) {
  return (
    <div className="space-y-3">
      <CheckedInBanner checkedInAt={checkedInAt} />
      <p className="text-sm text-zinc-800 font-medium">
        Step 2 — Take the BEFORE photo before you start.
      </p>
      <PhotoUploadStep
        eventId={eventId}
        kind="before"
        action={submitBeforePhoto}
        autoSubmit
      />
    </div>
  );
}

// ─── Step 3: Complete ────────────────────────────────────────────────────

function CompleteStep({
  eventId,
  eventType,
  completion,
}: {
  eventId: string;
  eventType: EventType;
  completion: CompletionRecord;
}) {
  return (
    <div className="space-y-3">
      <CheckedInBanner checkedInAt={completion.checkedInAt} />
      {eventType === 'job' && (
        <>
          <BeforePhotoThumb photos={completion.photos} />
          <p className="text-sm text-zinc-800 font-medium pt-2">
            Step 3 — Finish up with the AFTER photo, payment, and any notes.
          </p>
        </>
      )}
      <PhotoUploadStep
        eventId={eventId}
        kind={eventType === 'job' ? 'after' : 'photo'}
        action={submitCompletion}
        submitLabel="Mark Complete"
        pendingLabel="Submitting…"
        renderExtras={eventType === 'job' ? <PaymentSection /> : null}
        renderNoteField
      />
    </div>
  );
}

// ─── Shared step UI ─────────────────────────────────────────────────────

function CheckedInBanner({ checkedInAt }: { checkedInAt: string }) {
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-900">
      ✓ Checked in at {formatTime(checkedInAt)}
    </div>
  );
}

function BeforePhotoThumb({ photos }: { photos: CompletionRecord['photos'] }) {
  const before = photos.find((p) => p.label === 'before');
  if (!before) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <a href={before.url} target="_blank" rel="noreferrer" className="block">
        {/* Plain <img> — keeps client bundle small for what's just a thumb */}
        <img
          src={before.url}
          alt="Before"
          className="size-20 object-cover rounded-md border border-zinc-300"
        />
      </a>
      <span className="text-emerald-800">✓ Before photo captured</span>
    </div>
  );
}

interface PhotoUploadStepProps {
  eventId: string;
  kind: 'before' | 'after' | 'photo';
  action: (prev: ActionState | null, fd: FormData) => Promise<ActionState>;
  /** If true, the form auto-submits as soon as the photo finishes uploading. */
  autoSubmit?: boolean;
  /** Required when autoSubmit is false. */
  submitLabel?: string;
  pendingLabel?: string;
  renderExtras?: React.ReactNode;
  renderNoteField?: boolean;
}

function PhotoUploadStep({
  eventId,
  kind,
  action,
  autoSubmit,
  submitLabel = 'Submit',
  pendingLabel = 'Submitting…',
  renderExtras,
  renderNoteField,
}: PhotoUploadStepProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [state, formAction] = useActionState<ActionState | null, FormData>(action, null);
  const [isPending, startTransition] = useTransition();

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadedUrl(null);
    setLocalPreview(URL.createObjectURL(file));
    setIsUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `field/${eventId}/${kind}-${Date.now()}.${ext}`;
      const blob = await upload(path, file, {
        access: 'public',
        handleUploadUrl: '/api/photo-upload',
      });
      setUploadedUrl(blob.url);

      if (autoSubmit) {
        const fd = new FormData();
        fd.set('eventId', eventId);
        fd.set('photoUrl', blob.url);
        startTransition(() => formAction(fd));
      }
    } catch (err) {
      console.error('photo upload failed', err);
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  }

  function handleManualSubmit(formData: FormData) {
    if (!uploadedUrl) return;
    formData.set('eventId', eventId);
    formData.set('photoUrl', uploadedUrl);
    startTransition(() => formAction(formData));
  }

  const pickerLabel = isUploading
    ? 'Uploading…'
    : localPreview
      ? 'Retake / Choose Different Photo'
      : 'Take or Choose Photo';

  return (
    <form ref={formRef} action={handleManualSubmit} className="space-y-4">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={isUploading || isPending}
        className="block w-full text-center py-4 px-4 rounded-lg bg-zinc-900 text-white font-medium active:bg-zinc-700 disabled:bg-zinc-400"
      >
        {pickerLabel}
      </button>

      {localPreview && (
        // Plain <img>: object URL revokes naturally, no optimization needed.
        <img
          src={localPreview}
          alt="Selected"
          className="w-full rounded-lg object-cover max-h-64 border border-zinc-200"
        />
      )}
      {uploadError && (
        <p className="text-sm text-red-700">Upload failed: {uploadError}</p>
      )}
      {autoSubmit && isPending && (
        <p className="text-sm text-zinc-500">Saving…</p>
      )}
      {autoSubmit && uploadedUrl && !isPending && !state?.error && (
        <p className="text-sm text-emerald-700">✓ Saved — next step loading…</p>
      )}
      {!autoSubmit && uploadedUrl && !isUploading && (
        <p className="text-sm text-emerald-700">✓ Photo ready</p>
      )}

      {renderExtras}

      {renderNoteField && (
        <label className="block">
          <span className="text-sm font-medium text-zinc-800">Notes (optional)</span>
          <textarea
            name="note"
            rows={3}
            className="mt-1 block w-full rounded-lg border border-zinc-300 p-3 text-base"
            placeholder="Anything Matt should know?"
          />
        </label>
      )}

      {!autoSubmit && (
        <button
          type="submit"
          disabled={!uploadedUrl || isUploading || isPending}
          className="w-full py-4 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
        >
          {isPending ? pendingLabel : submitLabel}
        </button>
      )}

      <ErrorBox error={state?.error} />
    </form>
  );
}

function PaymentSection() {
  const options = [
    { value: 'cash',         label: 'Cash',         helper: 'Marks the invoice paid in QuickBooks.' },
    { value: 'check',        label: 'Check',        helper: 'Marks the invoice paid in QuickBooks.' },
    { value: 'card',         label: 'Card',         helper: 'Verifies QB shows it paid; alerts Matt if not.' },
    { value: 'not_yet_paid', label: 'Not Yet Paid', helper: 'Sends the invoice immediately for the customer to pay.' },
  ];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-zinc-800 mb-1">
        Payment status <span className="text-red-600">*</span>
      </legend>
      {options.map((opt) => (
        <label
          key={opt.value}
          className="block rounded-lg border border-zinc-300 p-3 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 active:bg-zinc-100"
        >
          <span className="flex items-center gap-3">
            <input type="radio" name="paymentStatus" value={opt.value} className="size-5" required />
            <span className="font-medium">{opt.label}</span>
          </span>
          <span className="block pl-8 text-xs text-zinc-500 mt-1">{opt.helper}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ErrorBox({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
      {error}
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}
