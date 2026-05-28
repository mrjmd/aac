'use client';

import { useState, useTransition } from 'react';
import { sendRunningLateText, type SendLateTextResult } from './actions';

export interface UpcomingEvent {
  id: string;
  summary: string;
  startLabel: string;
  /** E.164 customer phone, or null if PD has none on file. */
  customerPhone: string | null;
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'sending'; minutes: number }
  | { kind: 'sent'; minutes: number; toName: string }
  | { kind: 'error'; message: string };

export default function RunningLateList({ events }: { events: UpcomingEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
        No upcoming jobs left today.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {events.map((evt) => (
        <li key={evt.id}>
          <Row event={evt} />
        </li>
      ))}
    </ul>
  );
}

function Row({ event }: { event: UpcomingEvent }) {
  const [state, setState] = useState<RowState>({ kind: 'idle' });
  const [, startTransition] = useTransition();

  function send(minutes: number) {
    setState({ kind: 'sending', minutes });
    startTransition(async () => {
      const result: SendLateTextResult = await sendRunningLateText(event.id, minutes);
      if (result.ok) {
        setState({ kind: 'sent', minutes: result.minutes, toName: result.toName });
      } else {
        setState({ kind: 'error', message: result.error });
      }
    });
  }

  const phone = event.customerPhone;
  const isAnySending = state.kind === 'sending';

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="font-display text-sm font-bold text-aac-dark">{event.summary}</p>
        <p className="shrink-0 text-xs text-zinc-500">{event.startLabel}</p>
      </div>

      {phone ? (
        <div className="mb-3 flex gap-2">
          <a
            href={`tel:${phone}`}
            aria-label={`Call ${event.summary}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-aac-blue/30 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5"
          >
            <PhoneIcon className="h-3.5 w-3.5" />
            Call
          </a>
          <a
            href={`sms:${phone}`}
            aria-label={`Text ${event.summary}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-aac-blue/30 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5"
          >
            <ChatIcon className="h-3.5 w-3.5" />
            Text
          </a>
        </div>
      ) : (
        <p className="mb-3 text-xs text-zinc-500">No phone on file for this customer.</p>
      )}

      {state.kind === 'sent' ? (
        <p className="text-sm font-medium text-green-700">
          Texted {state.toName}: running {state.minutes} min late ✓
        </p>
      ) : state.kind === 'error' ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-red-700">{state.message}</p>
          <button
            type="button"
            onClick={() => setState({ kind: 'idle' })}
            className="text-xs font-semibold uppercase tracking-wider text-aac-blue"
          >
            Try again
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Text running late
          </p>
          <div className="flex gap-2">
            {[5, 10, 15].map((m) => {
              const isSendingThis = state.kind === 'sending' && state.minutes === m;
              return (
                <button
                  key={m}
                  type="button"
                  disabled={isAnySending || !phone}
                  onClick={() => send(m)}
                  className="flex-1 rounded-lg border border-aac-blue/30 bg-white px-2 py-3 text-sm font-bold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5 disabled:opacity-50"
                >
                  {isSendingThis ? 'Sending…' : `${m} min`}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2z" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-4H6V8h12v2zm0-4H6V4h12v2z" />
    </svg>
  );
}
