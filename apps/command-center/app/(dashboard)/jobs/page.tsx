
import { nyDate } from "@aac/items";
import { cn } from "@aac/ui";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../components/freshness";

export const dynamic = "force-dynamic";

function fmtWeek(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const pct = (p: number | null) => (p === null ? "OOO" : `${Math.round(p * 100)}%`);

export default async function JobsPage() {
  const today = nyDate(new Date());
  const card = cards.techWeeks();
  const { snap, error } = await loadSafe(card);
  if (!snap) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Jobs</h1>
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Couldn&apos;t read the calendar: {error}
        </p>
      </div>
    );
  }
  const weeks = snap.data;
  const thisWeekIdx = weeks.findIndex((w, i) => w.weekStart <= today && (weeks[i + 1]?.weekStart ?? "9999") > today);
  const ahead = weeks.slice(thisWeekIdx + 1);
  const fullWeeksAhead = ahead.filter((w) => (w.bookedPct ?? 0) >= 0.75).length;

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Jobs</h1>
        <Freshness name={card.name} fetchedAt={snap.fetchedAt} label="Mike's calendar," className="mt-1" />
      </header>

      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Booked ahead</p>
        <p className="font-display mt-1 text-2xl font-bold text-aac-dark">
          {fullWeeksAhead} of {ahead.length} upcoming weeks at 75%+
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          The operating model needs 2-3 weeks booked out.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Mike booked % by week</h2>
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
          {weeks.map((w, i) => {
            const p = w.bookedPct ?? 0;
            const current = i === thisWeekIdx;
            return (
              <div key={w.weekStart} className={cn("px-4 py-3", current && "bg-aac-blue/5")}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-semibold text-aac-dark">
                    Week of {fmtWeek(w.weekStart)}
                    {current && <span className="ml-2 text-xs font-medium text-aac-blue">this week</span>}
                    {i < thisWeekIdx && <span className="ml-2 text-xs font-normal text-zinc-400">past</span>}
                  </p>
                  <p className="text-sm font-bold tabular-nums text-aac-dark">{pct(w.bookedPct)}</p>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={cn("h-full rounded-full", p >= 0.75 ? "bg-aac-blue" : p >= 0.4 ? "bg-aac-blue/60" : "bg-amber-400")}
                    style={{ width: `${Math.min(100, Math.round(p * 100))}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-zinc-500">
                  {w.bookedHours}h of {w.capacityHours}h · jobs {w.byType.job}h · assessments {w.byType.assessment}h
                  {w.byType.callback ? ` · callbacks ${w.byType.callback}h` : ""}
                  {w.byType.other ? ` · other ${w.byType.other}h` : ""}
                  {w.heldHours ? ` · ${w.heldHours}h on hold (offered, unconfirmed)` : ""}
                  {w.capacityHours < 40 ? ` · ${40 - w.capacityHours}h out of office` : ""}
                </p>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-zinc-400">
          Booked = events with Mike as an attendee, by event length (all-day events count 8h per weekday). Capacity =
          5 days x 8h minus &ldquo;Mike OOO&rdquo; time. HOLD placeholders are shown separately and not counted.
          Saturday work can push a week past 100%.
        </p>
      </section>
    </div>
  );
}
