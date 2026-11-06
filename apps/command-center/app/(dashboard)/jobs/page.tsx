import { easternDate } from "@aac/shared-utils/eastern";
import { cards, loadSafe } from "@/lib/cards";
import { bookedAhead } from "@aac/metrics";
import { Freshness } from "../components/freshness";
import { NeedsAttention } from "../components/items";
import { PageHeader, SourceError, Tile } from "../components/layout-parts";

export const dynamic = "force-dynamic";

function fmtWeek(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const pct = (p: number | null | undefined) => (p == null ? "OOO" : `${Math.round(p * 100)}%`);

export default async function JobsPage() {
  const today = easternDate(new Date());
  const card = cards.techWeeks();
  const { snap, error } = await loadSafe(card);
  const header = (
    <PageHeader
      eyebrow="Area"
      title="Jobs"
      sub={
        <>
          Capacity, this week and what&apos;s ahead ·{" "}
          {snap && <Freshness name={card.name} fetchedAt={snap.fetchedAt} label="Mike's calendar" />}
        </>
      }
    />
  );
  if (!snap) {
    return (
      <>
        {header}
        <SourceError what="the calendar" error={error} />
        <NeedsAttention areas={["jobs"]} />
      </>
    );
  }
  const weeks = snap.data;
  const b = bookedAhead(weeks, today);
  const tw = b.thisWeek;

  return (
    <>
      {header}
      <NeedsAttention areas={["jobs"]} />
      <div className="tiles">
        <Tile
          k="Booked out"
          v={`${b.full} of ${b.of} wks`}
          s="Goal 2-3 weeks"
          tone={b.full >= 2 ? "good" : "bad"}
          def="Upcoming weeks with Mike 75%+ booked. Source: Calendar (events Mike attends)."
        />
        <Tile
          k="Mike, this week"
          v={pct(tw?.bookedPct)}
          s={tw ? `${tw.bookedHours}h of ${tw.capacityHours}h` : undefined}
          def="Booked hours / available hours. Capacity is 5 x 8h minus Mike OOO time."
        />
        <Tile
          k="On hold this week"
          v={`${tw?.heldHours ?? 0}h`}
          s="Offered, not confirmed"
          def="HOLD placeholders. Shown separately, not counted as booked."
        />
        <Tile
          k="Callbacks this week"
          v={`${tw?.byType.callback ?? 0}h`}
          s="Yellow calendar events"
          def="Rework on completed jobs (colorId 5)."
        />
      </div>
      <div className="card">
        <h3>Mike booked % by week</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {weeks.map((w) => {
            const current = w.weekStart === tw?.weekStart;
            const past = w.weekStart < (tw?.weekStart ?? "");
            return (
              <div key={w.weekStart} style={past ? { opacity: 0.6 } : undefined}>
                <div className="gate">
                  <span>
                    Week of {fmtWeek(w.weekStart)}
                    {current && <span className="tag ontoday" style={{ marginLeft: 8 }}>This week</span>}
                  </span>
                  <span className="num">{pct(w.bookedPct)}</span>
                </div>
                <div className="bar" style={{ marginTop: 4 }}>
                  <span
                    style={{
                      width: `${Math.min(100, Math.round((w.bookedPct ?? 0) * 100))}%`,
                      background: (w.bookedPct ?? 0) >= 0.75 ? "var(--accent)" : (w.bookedPct ?? 0) >= 0.4 ? "#7fb0dc" : "#e59a1a",
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3, fontWeight: 600 }}>
                  {w.bookedHours}h of {w.capacityHours}h · jobs {w.byType.job}h · assessments {w.byType.assessment}h
                  {w.byType.callback ? ` · callbacks ${w.byType.callback}h` : ""}
                  {w.byType.other ? ` · other ${w.byType.other}h` : ""}
                  {w.heldHours ? ` · ${w.heldHours}h on hold` : ""}
                  {w.capacityHours < 40 ? ` · ${40 - w.capacityHours}h out of office` : ""}
                </div>
              </div>
            );
          })}
        </div>
        <div className="note">
          Booked = events with Mike as an attendee, by event length (all-day events count 8h per weekday). HOLD
          placeholders are shown separately and not counted. Saturday work can push a week past 100%.
        </div>
      </div>
    </>
  );
}
