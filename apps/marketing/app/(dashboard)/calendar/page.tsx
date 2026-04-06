import { MonthGrid } from "./month-grid";
import { getCalendarEvents } from "@/lib/calendar-sources";

export const dynamic = "force-dynamic";

interface SearchParams {
  month?: string; // YYYY-MM
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { month } = await searchParams;
  const { year, monthIndex } = parseMonthParam(month);

  // Fetch a window slightly wider than the visible grid (covers leading/trailing days)
  const windowStart = new Date(year, monthIndex - 1, 20);
  const windowEnd = new Date(year, monthIndex + 1, 10);
  const { events, errors } = await getCalendarEvents(windowStart, windowEnd);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-aac-dark">
            Calendar
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Everything scheduled across all platforms.
          </p>
        </div>
        <Legend />
      </div>

      {errors.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          Some sources failed to load: {errors.join(", ")}
        </div>
      )}

      <div className="mt-6">
        <MonthGrid year={year} monthIndex={monthIndex} events={events} />
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseMonthParam(month?: string): { year: number; monthIndex: number } {
  const now = new Date();
  if (!month) return { year: now.getFullYear(), monthIndex: now.getMonth() };
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return { year: now.getFullYear(), monthIndex: now.getMonth() };
  const year = parseInt(match[1], 10);
  const monthIndex = parseInt(match[2], 10) - 1;
  if (isNaN(year) || isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return { year: now.getFullYear(), monthIndex: now.getMonth() };
  }
  return { year, monthIndex };
}

function Legend() {
  const items: { label: string; color: string }[] = [
    { label: "Social", color: "bg-aac-blue" },
    { label: "GBP", color: "bg-emerald-500" },
    { label: "Blog", color: "bg-indigo-500" },
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-zinc-500">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${i.color}`} />
          {i.label}
        </div>
      ))}
    </div>
  );
}

