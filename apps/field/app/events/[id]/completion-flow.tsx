'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
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
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="eventId" value={eventId} />
      <p className="text-sm text-zinc-600">
        Tap when you arrive at the job site.
      </p>
      <SubmitButton label="Check In" pendingLabel="Checking in…" />
      <ErrorBox error={state?.error} />
    </form>
  );
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
        buttonLabel="Save Before Photo"
        pendingLabel="Uploading…"
        action={submitBeforePhoto}
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
        buttonLabel="Mark Complete"
        pendingLabel="Submitting…"
        action={submitCompletion}
        renderExtras={
          eventType === 'job' ? (
            <PaymentSection />
          ) : null
        }
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
  buttonLabel: string;
  pendingLabel: string;
  action: (prev: ActionState | null, fd: FormData) => Promise<ActionState>;
  renderExtras?: React.ReactNode;
  renderNoteField?: boolean;
}

function PhotoUploadStep({
  eventId,
  kind,
  buttonLabel,
  pendingLabel,
  action,
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
      const path = `field/${eventId}/${kind}-${Date.now()}.${file.name.split('.').pop() || 'jpg'}`;
      const blob = await upload(path, file, {
        access: 'public',
        handleUploadUrl: '/api/photo-upload',
      });
      setUploadedUrl(blob.url);
    } catch (err) {
      console.error(err);
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  }

  function handleSubmit(formData: FormData) {
    if (!uploadedUrl) return;
    formData.set('eventId', eventId);
    formData.set('photoUrl', uploadedUrl);
    startTransition(() => formAction(formData));
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div>
        <label className="block">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="sr-only"
          />
          <span
            onClick={() => fileRef.current?.click()}
            className="block text-center py-4 px-4 rounded-lg bg-zinc-900 text-white font-medium active:bg-zinc-700 cursor-pointer"
          >
            {localPreview ? 'Retake / Choose Different Photo' : 'Take or Choose Photo'}
          </span>
        </label>
        {localPreview && (
          // Plain <img>: simpler than next/image for an instantly-revoked
          // object URL, and we don't need optimization for a thumb here.
          <img
            src={localPreview}
            alt="Selected"
            className="mt-3 w-full rounded-lg object-cover max-h-64 border border-zinc-200"
          />
        )}
        {isUploading && (
          <p className="mt-2 text-sm text-zinc-500">Uploading photo…</p>
        )}
        {uploadedUrl && !isUploading && (
          <p className="mt-2 text-sm text-emerald-700">✓ Photo uploaded</p>
        )}
        {uploadError && (
          <p className="mt-2 text-sm text-red-700">Upload failed: {uploadError}</p>
        )}
      </div>

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

      <button
        type="submit"
        disabled={!uploadedUrl || isUploading || isPending}
        className="w-full py-4 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
      >
        {isPending ? pendingLabel : buttonLabel}
      </button>

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

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full py-4 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
    >
      {pending ? pendingLabel : label}
    </button>
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
