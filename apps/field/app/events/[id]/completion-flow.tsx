'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { upload } from '@vercel/blob/client';
import { checkIn, submitBeforePhoto, submitCompletion, type ActionState } from './actions';
import type { CompletionPhoto, CompletionRecord, PaymentStatus } from '@/lib/completion';
import type { EventType } from '@/lib/event-classification';

interface Props {
  eventId: string;
  eventType: EventType;
  completion: CompletionRecord | null;
}

/**
 * Always-visible checklist of every step in the field flow. Each row shows
 * one of three states:
 *
 *   pending — greyed placeholder, no interaction yet
 *   current — expanded with the action UI (form / button)
 *   done    — checkmark + summary (timestamp, photo thumb, payment label)
 *
 * Non-job events (assessments, callbacks) skip the Before-Photo row.
 */
export default function CompletionChecklist({ eventId, eventType, completion }: Props) {
  const phase = completion?.phase ?? null;
  const checkedIn = phase !== null;
  const beforeTaken = phase === 'before_photo_taken' || phase === 'completed';
  const completed = phase === 'completed';
  const allDone = completed;

  // Row states
  const checkInState: RowState = checkedIn ? 'done' : 'current';
  const beforeState: RowState = beforeTaken ? 'done' : checkedIn ? 'current' : 'pending';
  const completeState: RowState = (() => {
    if (completed) return 'done';
    if (eventType === 'job' && beforeTaken) return 'current';
    if (eventType !== 'job' && checkedIn) return 'current';
    return 'pending';
  })();

  return (
    <div className="space-y-3">
      {allDone && (
        <div className="bg-emerald-100 border border-emerald-300 rounded-lg px-4 py-3 text-emerald-900 font-semibold text-center">
          ✓ Job complete
        </div>
      )}

      <StepRow number={1} state={checkInState} title="Check in" doneSummary={checkedIn ? `at ${formatTime(completion!.checkedInAt)}` : undefined}>
        {checkInState === 'current' && <CheckInStep eventId={eventId} />}
        {/* No expanded content for done — summary is in the row header */}
      </StepRow>

      {eventType === 'job' && (
        <StepRow
          number={2}
          state={beforeState}
          title="Before photo"
          doneSummary={beforeTaken ? 'captured' : undefined}
        >
          {beforeState === 'current' && (
            <PhotoUploadStep
              eventId={eventId}
              kind="before"
              action={submitBeforePhoto}
              autoSubmit
            />
          )}
          {beforeState === 'done' && completion && <BeforeThumbnail completion={completion} />}
        </StepRow>
      )}

      <StepRow
        number={eventType === 'job' ? 3 : 2}
        state={completeState}
        title={eventType === 'job' ? 'Complete job' : 'Complete'}
        doneSummary={completed ? `at ${formatTime(completion!.completedAt ?? completion!.checkedInAt)}` : undefined}
      >
        {completeState === 'current' && (
          <PhotoUploadStep
            eventId={eventId}
            kind={eventType === 'job' ? 'after' : 'photo'}
            action={submitCompletion}
            submitLabel="Mark Complete"
            pendingLabel="Submitting…"
            renderExtras={eventType === 'job' ? <PaymentSection /> : null}
            renderNoteField
          />
        )}
        {completeState === 'done' && completion && <CompletedDetails completion={completion} />}
      </StepRow>
    </div>
  );
}

// ─── Step row chrome ─────────────────────────────────────────────────────

type RowState = 'pending' | 'current' | 'done';

function StepRow({
  number,
  state,
  title,
  doneSummary,
  children,
}: {
  number: number;
  state: RowState;
  title: string;
  doneSummary?: string;
  children?: React.ReactNode;
}) {
  const bg =
    state === 'done' ? 'bg-emerald-50 border-emerald-200'
    : state === 'pending' ? 'bg-zinc-50 border-zinc-200'
    : 'bg-white border-zinc-300 shadow-sm';
  const labelColor =
    state === 'done' ? 'text-emerald-900'
    : state === 'pending' ? 'text-zinc-400'
    : 'text-zinc-900';

  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className="flex items-center gap-3">
        <StepIcon number={number} state={state} />
        <div className="flex-1">
          <p className={`font-medium leading-tight ${labelColor}`}>{title}</p>
          {doneSummary && (
            <p className="text-xs text-emerald-700 mt-0.5">{doneSummary}</p>
          )}
        </div>
      </div>
      {children && (
        <div className="mt-3">
          {children}
        </div>
      )}
    </div>
  );
}

function StepIcon({ number, state }: { number: number; state: RowState }) {
  if (state === 'done') {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-emerald-600 text-white text-base font-bold">
        ✓
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full border-2 border-zinc-300 text-zinc-400 text-sm font-semibold">
        {number}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center size-7 rounded-full bg-blue-600 text-white text-sm font-semibold">
      {number}
    </span>
  );
}

// ─── Done-state sub-views ────────────────────────────────────────────────

function BeforeThumbnail({ completion }: { completion: CompletionRecord }) {
  const before = completion.photos.find((p) => p.label === 'before');
  if (!before) return null;
  return (
    <a href={before.url} target="_blank" rel="noreferrer">
      <img
        src={before.url}
        alt="Before"
        className="size-24 object-cover rounded-md border border-emerald-200"
      />
    </a>
  );
}

function CompletedDetails({ completion }: { completion: CompletionRecord }) {
  const afterPhoto = completion.photos.find((p) => p.label === 'after' || p.label === 'photo');
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {completion.photos.map((p) => (
          <a key={p.url} href={p.url} target="_blank" rel="noreferrer">
            <img
              src={p.url}
              alt={p.label}
              className="size-20 object-cover rounded-md border border-emerald-200"
            />
          </a>
        ))}
      </div>
      {completion.paymentStatus && (
        <p className="text-sm text-emerald-900">
          Payment: <span className="font-medium">{labelForPayment(completion.paymentStatus)}</span>
        </p>
      )}
      {completion.checkInLocation && (
        <p className="text-xs text-emerald-700">
          <a
            href={`https://www.google.com/maps?q=${completion.checkInLocation.latitude},${completion.checkInLocation.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Check-in location on map
          </a>{' '}
          (±{Math.round(completion.checkInLocation.accuracy)}m)
        </p>
      )}
      {completion.note && (
        <p className="text-sm text-emerald-900 whitespace-pre-wrap italic">
          “{completion.note}”
        </p>
      )}
      {!afterPhoto && null /* afterPhoto unused — silences lint */}
    </div>
  );
}

function labelForPayment(s: PaymentStatus): string {
  switch (s) {
    case 'cash': return 'Cash';
    case 'check': return 'Check';
    case 'card': return 'Card';
    case 'not_yet_paid': return 'Not Yet Paid (invoice sent)';
  }
}

// ─── Current-step interactive widgets ────────────────────────────────────

function CheckInStep({ eventId }: { eventId: string }) {
  const [state, formAction] = useActionState<ActionState | null, FormData>(checkIn, null);
  const [isPending, startTransition] = useTransition();

  async function handleCheckIn() {
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
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleCheckIn}
        disabled={isPending}
        className="w-full py-3 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
      >
        {isPending ? 'Checking in…' : 'Check In'}
      </button>
      <ErrorBox error={state?.error} />
    </div>
  );
}

interface PhotoUploadStepProps {
  eventId: string;
  kind: 'before' | 'after' | 'photo';
  action: (prev: ActionState | null, fd: FormData) => Promise<ActionState>;
  autoSubmit?: boolean;
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
    <form action={handleManualSubmit} className="space-y-3">
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
        className="block w-full text-center py-3 px-4 rounded-lg bg-zinc-900 text-white font-medium active:bg-zinc-700 disabled:bg-zinc-400"
      >
        {pickerLabel}
      </button>

      {localPreview && (
        <img
          src={localPreview}
          alt="Selected"
          className="w-full rounded-lg object-cover max-h-56 border border-zinc-200"
        />
      )}
      {uploadError && <p className="text-sm text-red-700">Upload failed: {uploadError}</p>}
      {autoSubmit && isPending && <p className="text-sm text-zinc-500">Saving…</p>}
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
          className="w-full py-3 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
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

function getGeolocationOnce({ timeoutMs, maxAgeMs }: { timeoutMs: number; maxAgeMs: number }):
  Promise<{ ok: true; coords: { latitude: number; longitude: number; accuracy: number } } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, error: 'Geolocation API not available' });
      return;
    }
    const safety = setTimeout(() => resolve({ ok: false, error: 'Geolocation timed out (safety)' }), timeoutMs + 1000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(safety);
        resolve({ ok: true, coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy } });
      },
      (err) => {
        clearTimeout(safety);
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
