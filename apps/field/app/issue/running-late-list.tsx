'use client';

import { useState, useTransition } from 'react';
import { sendRunningLateText, type SendLateTextResult } from './actions';

export interface UpcomingEvent {
  id: string;
  summary: string;
  startLabel: string;
  hasPhone: boolean;
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

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="font-display text-sm font-bold text-aac-dark">{event.summary}</p>
        <p className="shrink-0 text-xs text-zinc-500">{event.startLabel}</p>
      </div>

      {!event.hasPhone ? (
        <p className="text-xs text-zinc-500">No phone on file — call Matt to update PD.</p>
      ) : state.kind === 'sent' ? (
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
        <div className="flex gap-2">
          {[5, 10, 15].map((m) => {
            const isSendingThis = state.kind === 'sending' && state.minutes === m;
            const isAnySending = state.kind === 'sending';
            return (
              <button
                key={m}
                type="button"
                disabled={isAnySending}
                onClick={() => send(m)}
                className="flex-1 rounded-lg border border-aac-blue/30 bg-white px-2 py-3 text-sm font-bold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5 disabled:opacity-50"
              >
                {isSendingThis ? 'Sending…' : `${m} min`}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
