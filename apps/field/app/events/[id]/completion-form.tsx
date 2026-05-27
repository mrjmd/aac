'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { submitCompletion, type SubmitState } from './actions';
import type { EventType } from '@/lib/event-classification';

interface Props {
  eventId: string;
  eventType: EventType;
}

const PAYMENT_OPTIONS: { value: string; label: string; helper: string }[] = [
  { value: 'cash',        label: 'Cash',        helper: 'I’ll mark the invoice paid in QuickBooks.' },
  { value: 'check',       label: 'Check',       helper: 'I’ll mark the invoice paid in QuickBooks.' },
  { value: 'card',        label: 'Card',        helper: 'I’ll verify QuickBooks already shows it paid; alert Matt if not.' },
  { value: 'not_yet_paid', label: 'Not Yet Paid', helper: 'I’ll send the invoice to the customer’s email immediately.' },
];

export default function CompletionForm({ eventId, eventType }: Props) {
  const [state, formAction] = useActionState(submitCompletion, null as SubmitState | null);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="eventId" value={eventId} />

      {eventType === 'job' ? (
        <>
          <PhotoField name="photoBefore" label="Before photo" required />
          <PhotoField name="photoAfter" label="After photo" required />
        </>
      ) : (
        <PhotoField
          name="photo"
          label={eventType === 'assessment' ? 'Photo of the issue' : 'Photo'}
          required
        />
      )}

      {eventType === 'job' && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-zinc-800 mb-1">
            Payment status <span className="text-red-600">*</span>
          </legend>
          {PAYMENT_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="block rounded-lg border border-zinc-300 p-3 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 active:bg-zinc-100"
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="paymentStatus"
                  value={opt.value}
                  className="size-5"
                  required
                />
                <span className="font-medium">{opt.label}</span>
              </span>
              <span className="block pl-8 text-xs text-zinc-500 mt-1">{opt.helper}</span>
            </label>
          ))}
        </fieldset>
      )}

      <label className="block">
        <span className="text-sm font-medium text-zinc-800">Notes (optional)</span>
        <textarea
          name="note"
          rows={3}
          className="mt-1 block w-full rounded-lg border border-zinc-300 p-3 text-base"
          placeholder="Anything Matt should know about this job?"
        />
      </label>

      {state?.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}

function PhotoField({ name, label, required }: { name: string; label: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-800">
        {label} {required && <span className="text-red-600">*</span>}
      </span>
      <input
        type="file"
        name={name}
        accept="image/*"
        capture="environment"
        required={required}
        className="mt-2 block w-full text-sm file:mr-3 file:py-3 file:px-4 file:rounded-lg file:border-0 file:bg-zinc-900 file:text-white file:font-medium file:active:bg-zinc-700"
      />
    </label>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full py-4 rounded-lg bg-blue-600 text-white font-medium active:bg-blue-700 disabled:bg-zinc-300 disabled:text-zinc-600"
    >
      {pending ? 'Submitting…' : 'Mark Complete'}
    </button>
  );
}
