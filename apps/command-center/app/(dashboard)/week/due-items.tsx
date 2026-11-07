"use client";

import { easternDate } from "@aac/shared-utils/eastern";
import type { Item } from "@aac/items";
import { ItemCard } from "../components/items";
import { KIND, useItems } from "../items-context";

const SEV_CLASS = { red: "red", yellow: "", info: "info" } as const;
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

/** The day an item comes due: the event it's about (dueOn), else a promised time (dueAt). */
function dueDay(i: Item): string | null {
  const at = i.dueOn ?? i.dueAt;
  return at ? easternDate(at) : null;
}

/** Every open item with a due day in [from, to], folded ones included (one person = one card elsewhere, but each due day counts). */
function useDue(from: string, to: string): Array<{ item: Item; day: string }> {
  const { view } = useItems();
  if (!view) return [];
  const all = view.items.flatMap((i) => [i, ...(i.related ?? [])]).filter((i) => i.lane !== "confirm");
  return all
    .map((item) => ({ item, day: dueDay(item) }))
    .filter((x): x is { item: Item; day: string } => !!x.day && x.day >= from && x.day <= to)
    .sort((a, b) => a.day.localeCompare(b.day) || b.item.score - a.item.score);
}

function short(i: Item): string {
  const kind = KIND[i.detector] ?? i.detector;
  return i.customer ? `${i.customer} · ${kind}` : i.title.length > 48 ? `${i.title.slice(0, 47)}…` : i.title;
}

/** The items due on one day of the week grid, as flags that open the drawer. */
export function DayFlags({ day }: { day: string }) {
  const { setOpen } = useItems();
  const due = useDue(day, day);
  return (
    <>
      {due.map(({ item }) => (
        <button key={item.key} type="button" className={`flag ${SEV_CLASS[item.severity]}`} onClick={() => setOpen(item)}>
          {short(item)}
          {item.band === "today" && <span className="ot">Today</span>}
        </button>
      ))}
    </>
  );
}

/** Mockup's "Get ahead of": this week's due items not on Today yet, by day. */
export function GetAheadOf({ from, to }: { from: string; to: string }) {
  const { view, error } = useItems();
  const due = useDue(from, to);
  if (!view) return <div className="empty">{error || "Loading items…"}</div>;
  const notToday = due.filter((x) => x.item.band !== "today");
  const onToday = due.length - notToday.length;
  return (
    <section className="sec">
      <div className="sec-h">
        <h2>Get ahead of · {notToday.length}</h2>
        <span className="hint">
          {onToday ? `${onToday} more from this week ${onToday === 1 ? "is" : "are"} already on Today. ` : ""}→ Today puts one at the bottom of your
          list.
        </span>
      </div>
      <div className="list">
        {notToday.length ? (
          notToday.map(({ item, day }) => <ItemCard key={item.key} item={item} ctx="week" day={weekday(day)} />)
        ) : (
          <div className="empty">Everything due this week is already on Today or handled.</div>
        )}
      </div>
    </section>
  );
}

/** Count for the glance strip. */
export function DueCount({ from, to }: { from: string; to: string }) {
  return <>{useDue(from, to).length}</>;
}
