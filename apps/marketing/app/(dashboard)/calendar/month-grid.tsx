"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar-sources/types";
import { EventCard } from "./event-card";
import { EventDetailPanel } from "./event-detail-panel";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  year: number;
  monthIndex: number;
  events: CalendarEvent[];
}

export function MonthGrid({ year, monthIndex, events }: Props) {
  const [selected, setSelected] = useState<CalendarEvent | null>(null);

  // Build day cells: 6 rows × 7 cols, padded with prev/next month days
  const firstOfMonth = new Date(year, monthIndex, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const cells: { date: Date; inMonth: boolean }[] = [];

  // Leading days from previous month
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({
      date: new Date(year, monthIndex, -i),
      inMonth: false,
    });
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, monthIndex, d), inMonth: true });
  }
  // Trailing days to fill grid (always show 6 rows = 42 cells)
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    cells.push({
      date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
      inMonth: false,
    });
  }

  // Group events by YYYY-MM-DD
  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.date);
    const key = ymd(d);
    const list = eventsByDay.get(key) ?? [];
    list.push(ev);
    eventsByDay.set(key, list);
  }

  const today = new Date();
  const todayKey = ymd(today);

  const prevMonth = monthIndex === 0
    ? `${year - 1}-12`
    : `${year}-${String(monthIndex).padStart(2, "0")}`;
  const nextMonth = monthIndex === 11
    ? `${year + 1}-01`
    : `${year}-${String(monthIndex + 2).padStart(2, "0")}`;

  return (
    <>
      {/* Month header */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-aac-dark">
          {MONTH_LABELS[monthIndex]} {year}
        </h2>
        <div className="flex gap-1">
          <Link
            href={`/calendar?month=${prevMonth}`}
            className="rounded-lg border border-zinc-200 p-1.5 text-zinc-500 hover:bg-zinc-100"
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </Link>
          <Link
            href="/calendar"
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 hover:bg-zinc-100"
          >
            Today
          </Link>
          <Link
            href={`/calendar?month=${nextMonth}`}
            className="rounded-lg border border-zinc-200 p-1.5 text-zinc-500 hover:bg-zinc-100"
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-t-xl border border-b-0 border-zinc-200 bg-zinc-200">
        {WEEKDAY_LABELS.map((d) => (
          <div
            key={d}
            className="bg-zinc-50 px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-b-xl border border-t-0 border-zinc-200 bg-zinc-200">
        {cells.map((cell, idx) => {
          const key = ymd(cell.date);
          const dayEvents = eventsByDay.get(key) ?? [];
          const isToday = key === todayKey;
          const visibleEvents = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - visibleEvents.length;

          return (
            <div
              key={idx}
              className={`flex min-h-[110px] flex-col gap-1 bg-white p-1.5 ${
                cell.inMonth ? "" : "bg-zinc-50/50"
              }`}
            >
              <div
                className={`text-[11px] font-semibold ${
                  isToday
                    ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-aac-blue text-white"
                    : cell.inMonth
                      ? "text-zinc-600"
                      : "text-zinc-300"
                }`}
              >
                {cell.date.getDate()}
              </div>

              {visibleEvents.map((ev) => (
                <EventCard
                  key={ev.id}
                  event={ev}
                  onClick={() => setSelected(ev)}
                />
              ))}

              {overflow > 0 && (
                <button
                  onClick={() => {
                    // For now just open the first hidden event; full overflow popup is future work
                    setSelected(dayEvents[visibleEvents.length]);
                  }}
                  className="text-left text-[10px] font-medium text-zinc-400 hover:text-zinc-600"
                >
                  +{overflow} more
                </button>
              )}
            </div>
          );
        })}
      </div>

      {selected && (
        <EventDetailPanel
          event={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
