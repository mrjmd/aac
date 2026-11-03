import { nyDate } from "@aac/items";
import { cards, loadSafe } from "@/lib/cards";
import { bookedAhead, fieldDay, techOut, type FieldEvent } from "@/lib/field-events";
import { Freshness } from "../components/freshness";
import { Glance, OverviewTabs, PageHeader, SourceError } from "../components/layout-parts";

export const dynamic = "force-dynamic";

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });

/** Morning-only days have an open afternoon; a weekday with nothing is open all day. */
function openSlot(day: string, events: FieldEvent[], saturday: boolean): string | null {
  if (saturday) return null;
  if (!events.length) return "Open all day";
  const afternoon = events.some((e) => e.time === "All day" || /^(12|1|2|3|4|5)(:|$)/.test(e.time));
  return afternoon ? null : "Afternoon open";
}

export default async function WeekPage() {
  const today = nyDate(new Date());
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, dow === 0 ? 1 : 1 - dow);
  const days = Array.from({ length: 6 }, (_, n) => addDays(monday, n));
  const calCard = cards.calendarIndex();
  const [cal, weeks] = await Promise.all([loadSafe(calCard), loadSafe(cards.techWeeks())]);
  const byDay = days.map((d, n) => {
    const ev = cal.snap ? fieldDay(cal.snap.data, d) : [];
    const out = cal.snap ? techOut(cal.snap.data, d) : false;
    return { d, ev, out, open: d >= today && !out ? openSlot(d, ev, n === 5) : null };
  });
  const b = weeks.snap ? bookedAhead(weeks.snap.data, today) : null;
  const pct = b?.thisWeek?.bookedPct;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="This week"
        sub={
          <>
            {fmt(days[0], { month: "short", day: "numeric" })} to {fmt(days[5], { month: "short", day: "numeric" })} ·{" "}
            <Freshness name={calCard.name} fetchedAt={cal.snap?.fetchedAt} label="Calendar" />
          </>
        }
        right={<OverviewTabs on="/week" />}
      />
      {cal.error && <SourceError what="the calendar" error={cal.error} />}
      <div className="glance">
        <Glance k="Jobs on the calendar" v={byDay.reduce((n, x) => n + x.ev.filter((e) => e.cls === "job").length, 0)} />
        <Glance k="Mike booked" v={pct == null ? (b?.thisWeek ? "Out" : "?") : `${Math.round(pct * 100)}%`} />
        <Glance k="Open half-days" v={byDay.reduce((n, x) => n + (x.open === "Open all day" ? 2 : x.open ? 1 : 0), 0)} />
      </div>
      <div className="weekgrid">
        {byDay.map(({ d, ev, out, open }, n) => (
          <div key={d} className={`day${d === today ? " today" : ""}`}>
            <h4>
              <span className="micro">{d === today ? "Today" : fmt(d, { weekday: "short" })}</span>
              <span className="dt">{fmt(d, { day: "numeric" })}</span>
            </h4>
            {ev.map((e) => (
              <a key={e.id} className="cal" href={e.href} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>
                <span className={`dot ${e.cls}`} />
                <span>
                  {e.time} {e.title}
                </span>
              </a>
            ))}
            {out && <div className="flag snz">Mike out of office</div>}
            {open && <div className="slot">{open}</div>}
            {!ev.length && !out && n === 5 && <div className="daynote">Off</div>}
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Not built yet</h3>
        <div>
          The mockup also pins items to the day they come due (quote day-14s, holds to release, deposits) and lists them
          under &ldquo;Get ahead of&rdquo;. Detectors don&apos;t emit due dates yet, so those flags and the slot
          suggestions are missing.
        </div>
      </div>
    </>
  );
}
