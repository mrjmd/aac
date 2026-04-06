"use client";

import type { CalendarEvent, CalendarSource } from "@/lib/calendar-sources/types";

const SOURCE_STYLES: Record<CalendarSource, { bar: string; bg: string; text: string }> = {
  social: {
    bar: "border-l-aac-blue",
    bg: "bg-aac-blue/5 hover:bg-aac-blue/10",
    text: "text-aac-blue",
  },
  gbp: {
    bar: "border-l-emerald-500",
    bg: "bg-emerald-50 hover:bg-emerald-100",
    text: "text-emerald-700",
  },
  blog: {
    bar: "border-l-indigo-500",
    bg: "bg-indigo-50 hover:bg-indigo-100",
    text: "text-indigo-700",
  },
};

export function EventCard({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  const styles = SOURCE_STYLES[event.source];
  const time = formatTime(event.date);

  return (
    <button
      onClick={onClick}
      className={`w-full truncate rounded border-l-2 px-1.5 py-1 text-left text-[10px] font-medium ${styles.bar} ${styles.bg} ${styles.text}`}
      title={event.title}
    >
      {time && <span className="mr-1 opacity-60">{time}</span>}
      {event.title}
    </button>
  );
}

function formatTime(iso: string): string | null {
  const d = new Date(iso);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  // Skip time display if it's midnight (date-only event like blog posts)
  if (hours === 0 && minutes === 0) return null;
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? "a" : "p";
  return minutes === 0 ? `${h12}${ampm}` : `${h12}:${String(minutes).padStart(2, "0")}${ampm}`;
}
