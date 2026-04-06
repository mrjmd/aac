"use client";

import { X, ExternalLink } from "lucide-react";
import type { CalendarEvent, CalendarSource } from "@/lib/calendar-sources/types";

const SOURCE_LABELS: Record<CalendarSource, string> = {
  social: "Social Post",
  gbp: "Google Business Profile",
  blog: "Blog Post",
};

const SOURCE_BADGE: Record<CalendarSource, string> = {
  social: "bg-aac-blue/10 text-aac-blue",
  gbp: "bg-emerald-100 text-emerald-700",
  blog: "bg-indigo-100 text-indigo-700",
};

export function EventDetailPanel({
  event,
  onClose,
}: {
  event: CalendarEvent;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
        aria-hidden
      />

      {/* Slide-out panel */}
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${SOURCE_BADGE[event.source]}`}
            >
              {SOURCE_LABELS[event.source]}
            </span>
            <h2 className="mt-2 font-display text-lg font-bold text-aac-dark">
              {event.title}
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              {formatFullDate(event.date)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 p-5">
          {event.imageUrl && (
            <div className="mb-4 overflow-hidden rounded-lg border border-zinc-200">
              <img src={event.imageUrl} alt="" className="w-full" />
            </div>
          )}

          {event.excerpt && (
            <p className="text-sm text-zinc-600">{event.excerpt}</p>
          )}

          {event.status && (
            <div className="mt-4 flex items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-zinc-400">
                Status
              </span>
              <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600">
                {event.status}
              </span>
            </div>
          )}

          {event.url && (
            <a
              href={event.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-aac-blue px-3 py-2 text-xs font-semibold text-white hover:bg-aac-blue/90"
            >
              Open source <ExternalLink size={12} />
            </a>
          )}
        </div>
      </aside>
    </>
  );
}

function formatFullDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const hours = d.getHours();
  const minutes = d.getMinutes();
  if (hours === 0 && minutes === 0) return date;
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: minutes ? "2-digit" : undefined,
    hour12: true,
  });
  return `${date} • ${time}`;
}
