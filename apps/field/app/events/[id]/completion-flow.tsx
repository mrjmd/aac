'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { upload } from '@vercel/blob/client';
import {
  addPhotos,
  cancelEvent,
  checkIn,
  deletePhoto,
  submitBeforePhoto,
  submitCompletion,
  updateNote,
  type ActionState,
} from './actions';
import type { CompletionEdit, CompletionPhoto, CompletionRecord, PaymentStatus } from '@/lib/completion';
import type { EventType } from '@/lib/event-classification';
import type { EventTimeBucket } from '@/lib/event-time-bucket';

interface Props {
  eventId: string;
  eventType: EventType;
  completion: CompletionRecord | null;
  bucket: EventTimeBucket;
  /** Days late if bucket is past_not_completed; 0 otherwise. Used for the "logging late" banner copy. */
  daysLate: number;
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
export default function CompletionChecklist({ eventId, eventType, completion, bucket, daysLate }: Props) {
  if (bucket === 'cancelled' && completion?.cancelledAt) {
    return <CancelledView completion={completion} />;
  }

  if (bucket === 'future') {
    return <FutureView />;
  }

  const isLate = bucket === 'past_not_completed';
  const phase = completion?.phase ?? null;
  const checkedIn = phase !== null && phase !== 'cancelled';
  const beforeTaken = phase === 'before_photo_taken' || phase === 'completed';
  const completed = phase === 'completed';
  const allDone = completed;

  // Row states
  const checkInState: RowState = checkedIn ? 'done' : 'current';
  const beforeState: RowState = beforeTaken ? 'done' : checkedIn ? 'current' : 'pending';
  const completeState: RowState = (() => {
    if (completed) return 'done';
    if (eventType === 'repair' && beforeTaken) return 'current';
    if (eventType !== 'repair' && checkedIn) return 'current';
    return 'pending';
  })();

  return (
    <div className="space-y-3">
      {isLate && !completed && <LateBanner daysLate={daysLate} />}

      {allDone && (
        <div className="bg-emerald-100 border border-emerald-300 rounded-lg px-4 py-3 text-emerald-900 font-semibold text-center">
          ✓ Complete
          {typeof completion?.loggedLateBy === 'number' && completion.loggedLateBy > 0 && (
            <span className="ml-2 text-xs font-normal text-emerald-800">
              (logged {completion.loggedLateBy} day{completion.loggedLateBy === 1 ? '' : 's'} late)
            </span>
          )}
        </div>
      )}

      <StepRow number={1} state={checkInState} title={isLate ? 'Late check in' : 'Check in'} doneSummary={checkedIn ? `at ${formatTime(completion!.checkedInAt)}` : undefined}>
        {checkInState === 'current' && <CheckInStep eventId={eventId} skipGeo={isLate} />}
        {/* No expanded content for done — summary is in the row header */}
      </StepRow>

      {eventType === 'repair' && (
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
          {beforeState === 'done' && completion && (
            <BeforeThumbnail eventId={eventId} completion={completion} />
          )}
        </StepRow>
      )}

      <StepRow
        number={eventType === 'repair' ? 3 : 2}
        state={completeState}
        title={eventType === 'repair' ? 'Complete repair' : 'Complete'}
        doneSummary={completed ? `at ${formatTime(completion!.completedAt ?? completion!.checkedInAt)}` : undefined}
      >
        {completeState === 'current' && (
          <PhotoUploadStep
            eventId={eventId}
            kind={eventType === 'repair' ? 'after' : 'photo'}
            action={submitCompletion}
            submitLabel="Mark Complete"
            pendingLabel="Submitting…"
            renderExtras={
              <>
                <ExtrasSection eventId={eventId} />
                {eventType === 'repair' && <PaymentSection />}
              </>
            }
            renderNoteField
          />
        )}
        {completeState === 'done' && completion && (
          <CompletedDetails eventId={eventId} completion={completion} />
        )}
      </StepRow>

      {isLate && !completed && <CancelEventSection eventId={eventId} />}
    </div>
  );
}

// ─── Bucket-specific views ───────────────────────────────────────────────

function LateBanner({ daysLate }: { daysLate: number }) {
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg px-4 py-3">
      <p className="text-sm font-medium text-amber-900">
        Logging this {daysLate} day{daysLate === 1 ? '' : 's'} late
      </p>
      <p className="text-xs text-amber-800 mt-0.5">
        This job was scheduled in the past. We&apos;ll record it as a late completion.
      </p>
    </div>
  );
}

function FutureView() {
  return (
    <div className="bg-zinc-50 border border-zinc-200 rounded-lg px-4 py-6 text-center">
      <p className="text-sm font-medium text-zinc-700">This job is in the future.</p>
      <p className="text-xs text-zinc-600 mt-1">
        Check in on the day of the job.
      </p>
    </div>
  );
}

function CancelledView({ completion }: { completion: CompletionRecord }) {
  return (
    <div className="bg-zinc-100 border border-zinc-300 rounded-lg px-4 py-4 space-y-2">
      <p className="text-sm font-semibold text-zinc-800">Cancelled / not done</p>
      {completion.cancelledAt && (
        <p className="text-xs text-zinc-600">
          {formatTime(completion.cancelledAt)}
          {completion.cancelledByEmail ? ` · ${completion.cancelledByEmail}` : ''}
        </p>
      )}
      {completion.cancellationReason && (
        <p className="text-sm text-zinc-800 whitespace-pre-wrap italic">
          “{completion.cancellationReason}”
        </p>
      )}
    </div>
  );
}

function CancelEventSection({ eventId }: { eventId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="pt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm text-zinc-600 underline underline-offset-2"
        >
          Didn&apos;t do this job? Mark as cancelled / not done
        </button>
      </div>
    );
  }
  return <CancelForm eventId={eventId} onClose={() => setOpen(false)} />;
}

function CancelForm({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [state, formAction] = useActionState<ActionState | null, FormData>(cancelEvent, null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reason.trim()) return;
    const fd = new FormData();
    fd.set('eventId', eventId);
    fd.set('reason', reason.trim());
    startTransition(() => formAction(fd));
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-amber-900">Mark as cancelled / not done</p>
        <p className="text-xs text-amber-800 mt-1">
          This removes the job from your owed-photos list. Please say what happened.
        </p>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-amber-900">Reason (required)</span>
        <textarea
          required
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Customer cancelled morning of, rescheduled to next week"
          className="mt-1 block w-full rounded-lg border border-amber-300 bg-white p-3 text-base"
        />
      </label>
      <ErrorBox error={state?.error} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending || !reason.trim()}
          className="flex-1 py-2.5 rounded-lg bg-amber-700 text-white font-medium disabled:bg-zinc-300 disabled:text-zinc-600"
        >
          {isPending ? 'Cancelling…' : 'Confirm cancel'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="flex-1 py-2.5 rounded-lg border border-zinc-300 bg-white text-zinc-800 font-medium disabled:opacity-50"
        >
          Back
        </button>
      </div>
    </form>
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
    <span className="inline-flex items-center justify-center size-7 rounded-full bg-aac-blue text-white text-sm font-semibold">
      {number}
    </span>
  );
}

// ─── Done-state sub-views ────────────────────────────────────────────────

function BeforeThumbnail({ eventId, completion }: { eventId: string; completion: CompletionRecord }) {
  const before = completion.photos.find((p) => p.label === 'before');
  if (!before) return null;
  // Mid-flow only (not yet completed): allow retake — deleting the Before
  // photo reverts the phase so the step re-prompts.
  const midFlow = completion.phase !== 'completed';
  return (
    <div className="space-y-1.5">
      <a href={before.url} target="_blank" rel="noreferrer" className="inline-block">
        <img
          src={before.url}
          alt="Before"
          className="size-24 object-cover rounded-md border border-emerald-200"
        />
      </a>
      {midFlow && <DeletePhotoButton eventId={eventId} photo={before} variant="retake" />}
    </div>
  );
}

function CompletedDetails({ eventId, completion }: { eventId: string; completion: CompletionRecord }) {
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-2">
        {completion.photos.map((p) => (
          <li key={p.url} className="space-y-1">
            <a href={p.url} target="_blank" rel="noreferrer" className="block">
              {p.kind === 'video' ? (
                <div className="relative size-20 overflow-hidden rounded-md border border-emerald-200 bg-black">
                  <video
                    src={p.url}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                  <span className="absolute inset-0 flex items-center justify-center text-2xl text-white">
                    ▶
                  </span>
                </div>
              ) : (
                <img
                  src={p.url}
                  alt={p.label}
                  className="size-20 rounded-md border border-emerald-200 object-cover"
                />
              )}
            </a>
            <DeletePhotoButton eventId={eventId} photo={p} variant="delete" />
          </li>
        ))}
      </ul>
      <AddMorePhotos eventId={eventId} />
      {completion.paymentStatus && (
        <p className="text-sm text-emerald-900">
          Payment: <span className="font-medium">{labelForPayment(completion.paymentStatus)}</span>
          {completion.linkedInvoiceId && (
            <span className="text-xs text-emerald-700">
              {' '}· QB Invoice {completion.linkedInvoiceId}
              {completion.linkedPaymentId && ` · Payment ${completion.linkedPaymentId}`}
            </span>
          )}
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
      <EditableNote eventId={eventId} note={completion.note} />
      <ActivityLog completion={completion} />
    </div>
  );
}

/**
 * Two-tap delete: first tap arms an inline confirm, second tap deletes.
 * `retake` variant is the mid-flow Before-photo case (delete reverts the
 * phase so the step re-prompts).
 */
function DeletePhotoButton({
  eventId,
  photo,
  variant,
}: {
  eventId: string;
  photo: CompletionPhoto;
  variant: 'delete' | 'retake';
}) {
  const [armed, setArmed] = useState(false);
  const [state, formAction] = useActionState<ActionState | null, FormData>(deletePhoto, null);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    const fd = new FormData();
    fd.set('eventId', eventId);
    fd.set('photoUrl', photo.url);
    startTransition(() => formAction(fd));
  }

  if (!armed) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="text-xs text-zinc-500 underline underline-offset-2"
        >
          {variant === 'retake' ? 'Retake' : 'Delete'}
        </button>
        {state?.error && <p className="text-xs text-red-700 mt-1 max-w-40">{state.error}</p>}
      </div>
    );
  }
  return (
    <div className="flex gap-1.5">
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {isPending ? '…' : variant === 'retake' ? 'Retake?' : 'Delete?'}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        disabled={isPending}
        className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700"
      >
        Keep
      </button>
    </div>
  );
}

/**
 * Post-completion uploader: each picked file goes straight to Blob, then a
 * single addPhotos action attaches the batch to the record.
 */
function AddMorePhotos({ eventId }: { eventId: string }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, formAction] = useActionState<ActionState | null, FormData>(addPhotos, null);
  const [, startTransition] = useTransition();

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = '';
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('eventId', eventId);
      for (const file of files) {
        const isVideo = file.type.startsWith('video/');
        const ext = file.name.split('.').pop() || (isVideo ? 'mp4' : 'jpg');
        const path = `field/${eventId}/extra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const blob = await upload(path, file, {
          access: 'public',
          handleUploadUrl: '/api/photo-upload',
        });
        fd.append('photoUrl', blob.url);
        fd.append('photoKind', isVideo ? 'video' : 'image');
      }
      startTransition(() => formAction(fd));
    } catch (err) {
      console.error('add-more upload failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="block w-full rounded-lg border-2 border-dashed border-emerald-300 py-2 text-sm text-emerald-700 hover:border-aac-blue hover:text-aac-blue active:bg-emerald-50 disabled:opacity-50"
      >
        {busy ? 'Uploading…' : '+ Add photo or video'}
      </button>
      {error && <p className="text-xs text-red-700">Upload failed: {error}</p>}
      <ErrorBox error={state?.error} />
    </div>
  );
}

function EditableNote({ eventId, note }: { eventId: string; note?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const [state, formAction] = useActionState<ActionState | null, FormData>(updateNote, null);
  const [isPending, startTransition] = useTransition();

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData();
    fd.set('eventId', eventId);
    fd.set('note', draft);
    startTransition(() => {
      formAction(fd);
      setEditing(false);
    });
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        {note ? (
          <p className="text-sm text-emerald-900 whitespace-pre-wrap italic">“{note}”</p>
        ) : (
          <p className="text-sm text-zinc-500 italic">No notes.</p>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(note ?? '');
            setEditing(true);
          }}
          className="text-xs text-zinc-500 underline underline-offset-2"
        >
          {note ? 'Edit note' : 'Add a note'}
        </button>
        <ErrorBox error={state?.error} />
      </div>
    );
  }
  return (
    <form onSubmit={handleSave} className="space-y-2">
      <textarea
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Anything Matt should know?"
        className="block w-full rounded-lg border border-zinc-300 p-3 text-base"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 py-2 rounded-lg bg-aac-blue text-white text-sm font-medium disabled:bg-zinc-300"
        >
          {isPending ? 'Saving…' : 'Save note'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={isPending}
          className="flex-1 py-2 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Check-in / completion timestamps plus every post-submission edit. */
function ActivityLog({ completion }: { completion: CompletionRecord }) {
  const entries: { at: string; text: string }[] = [
    { at: completion.checkedInAt, text: `Checked in · ${completion.checkedInByEmail}` },
  ];
  if (completion.completedAt) {
    const late =
      typeof completion.loggedLateBy === 'number' && completion.loggedLateBy > 0
        ? ` (${completion.loggedLateBy}d late)`
        : '';
    entries.push({ at: completion.completedAt, text: `Completed${late}` });
  }
  for (const e of completion.edits ?? []) {
    entries.push({ at: e.at, text: `${labelForEdit(e)} · ${e.byEmail}` });
  }
  return (
    <div className="border-t border-emerald-200 pt-2">
      <p className="text-xs font-medium uppercase tracking-wide text-emerald-800 mb-1">Activity</p>
      <ul className="space-y-0.5">
        {entries.map((e, i) => (
          <li key={`${e.at}-${i}`} className="text-xs text-emerald-700">
            {formatDateTime(e.at)} — {e.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function labelForEdit(e: CompletionEdit): string {
  switch (e.action) {
    case 'photo_added': return 'Photo added';
    case 'photo_deleted': return 'Photo deleted';
    case 'note_updated': return 'Note updated';
  }
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

function CheckInStep({ eventId, skipGeo = false }: { eventId: string; skipGeo?: boolean }) {
  const [state, formAction] = useActionState<ActionState | null, FormData>(checkIn, null);
  const [isPending, startTransition] = useTransition();

  async function handleCheckIn() {
    const fd = new FormData();
    fd.set('eventId', eventId);
    if (!skipGeo) {
      const geo = await getGeolocationOnce({ timeoutMs: 5000, maxAgeMs: 60_000 });
      if (geo.ok) {
        fd.set('lat', String(geo.coords.latitude));
        fd.set('lng', String(geo.coords.longitude));
        fd.set('accuracy', String(geo.coords.accuracy));
        fd.set('geoTakenAt', new Date().toISOString());
      } else {
        fd.set('geoError', geo.error);
      }
    } else {
      // Late check-in: skip geo entirely — Mike isn't at the site, his
      // current location would be misleading data.
      fd.set('geoError', 'skipped-late-check-in');
    }
    startTransition(() => formAction(fd));
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleCheckIn}
        disabled={isPending}
        className="w-full py-3 rounded-lg bg-aac-blue text-white font-medium active:bg-aac-blue/90 disabled:bg-zinc-300 disabled:text-zinc-600"
      >
        {isPending ? 'Checking in…' : skipGeo ? 'Log late check-in' : 'Check In'}
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
          className="w-full py-3 rounded-lg bg-aac-blue text-white font-medium active:bg-aac-blue/90 disabled:bg-zinc-300 disabled:text-zinc-600"
        >
          {isPending ? pendingLabel : submitLabel}
        </button>
      )}

      <ErrorBox error={state?.error} />
    </form>
  );
}

interface Extra {
  url: string;
  kind: 'image' | 'video';
  localPreview: string;
}

/**
 * Optional grid of additional photos/videos Mike captures during the job.
 * Each file uploads to Vercel Blob as soon as it's picked, then renders as
 * a thumbnail with a remove button. Hidden inputs make the list available
 * to the enclosing <form>'s server action under extraUrl[] / extraKind[].
 */
function ExtrasSection({ eventId }: { eventId: string }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<Extra[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = ''; // allow picking the same file again later
    setError(null);
    for (const file of files) {
      const isVideo = file.type.startsWith('video/');
      const ext = file.name.split('.').pop() || (isVideo ? 'mp4' : 'jpg');
      const localPreview = URL.createObjectURL(file);
      setUploading(true);
      try {
        const path = `field/${eventId}/extra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const blob = await upload(path, file, {
          access: 'public',
          handleUploadUrl: '/api/photo-upload',
        });
        setItems((prev) => [...prev, { url: blob.url, kind: isVideo ? 'video' : 'image', localPreview }]);
      } catch (err) {
        console.error('extra upload failed', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    }
  }

  function remove(url: string) {
    setItems((prev) => prev.filter((it) => it.url !== url));
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3">
      <p className="text-sm font-medium text-zinc-800">
        More photos/videos <span className="font-normal text-zinc-500">(optional)</span>
      </p>
      {items.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {items.map((it) => (
            <li key={it.url} className="relative aspect-square">
              {it.kind === 'video' ? (
                <video
                  src={it.localPreview}
                  className="h-full w-full rounded-md border border-zinc-200 object-cover"
                  muted
                  playsInline
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.localPreview}
                  alt=""
                  className="h-full w-full rounded-md border border-zinc-200 object-cover"
                />
              )}
              <button
                type="button"
                aria-label="Remove"
                onClick={() => remove(it.url)}
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold leading-none text-white shadow"
              >
                ×
              </button>
              {it.kind === 'video' && (
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] uppercase tracking-wide text-white">
                  video
                </span>
              )}
              <input type="hidden" name="extraUrl" value={it.url} />
              <input type="hidden" name="extraKind" value={it.kind} />
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="block w-full rounded-lg border-2 border-dashed border-zinc-300 py-2 text-sm text-zinc-600 hover:border-aac-blue hover:text-aac-blue active:bg-zinc-50 disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : '+ Add photo or video'}
      </button>
      {error && <p className="text-xs text-red-700">Upload failed: {error}</p>}
    </div>
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
          className="block rounded-lg border border-zinc-300 p-3 has-[:checked]:border-aac-blue has-[:checked]:bg-aac-blue/5 active:bg-zinc-100"
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
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
