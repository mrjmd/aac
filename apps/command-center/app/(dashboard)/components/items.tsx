"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Sortable from "sortablejs";
import type { DismissReason, Item } from "@aac/items";
import { AREA_LABEL, KIND, RAIL_AREA, useItems } from "../items-context";
import { usePeople } from "../people-context";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const SEV_CLASS = { red: "red", yellow: "amber", info: "info" } as const;

const DISMISS_REASONS: Array<{ value: DismissReason; label: string }> = [
  { value: "not-real", label: "Not real" },
  { value: "already-handled", label: "Handled elsewhere" },
  { value: "not-mine", label: "Not mine" },
  { value: "wrong-match", label: "Wrong customer match" },
];

const SNOOZE: Array<[string, () => string]> = [
  ["This afternoon", () => at(0, 13)],
  ["Tomorrow", () => at(1, 7)],
  ["Monday", () => at(((8 - new Date().getDay()) % 7) || 7, 7)],
  ["Next week", () => at(7, 7)],
];

function at(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export function ago(iso: string): string {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const customerHref = (name: string) => `/customers?q=${encodeURIComponent(name)}`;

function Tags({ item, ctx }: { item: Item; ctx: Ctx }) {
  return (
    <>
      {ctx !== "area" && <span className="tag area">{AREA_LABEL[RAIL_AREA[item.area]]}</span>}
      <span className="tag">{KIND[item.detector] ?? item.detector}</span>
      {item.customer && <span className="tag">{item.customer}</span>}
      {item.phone && <span className="tag num">{item.phone}</span>}
      {item.amount !== undefined && <span className="tag num">{money(item.amount)}</span>}
      {item.rolloverDays !== undefined && item.rolloverDays >= 1 && (
        <span className="tag red">On Today {item.rolloverDays + 1} days running</span>
      )}
      {item.sensitive && <span className="tag sens">{item.sensitive === "money" ? "Money" : "Legal"}</span>}
      {item.detector.startsWith("L") && <span className="tag ai">AI-detected</span>}
      {item.state.reopenedAt && <span className="tag auto">Back: new evidence</span>}
      {ctx === "area" && item.band === "today" && <span className="tag ontoday">On Today</span>}
    </>
  );
}

type Ctx = "today" | "new" | "area";
type Panel = null | "snooze" | "more" | { confirm: "money" | "legal"; mode: "dismiss" | "mute"; reason?: DismissReason };

export function ItemCard({ item, ctx, n }: { item: Item; ctx: Ctx; n?: number }) {
  const { act, mute, say, setOpen } = useItems();
  const { people, change } = usePeople();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (p: "snooze" | "more") => setPanel(panel === p ? null : p);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const undo = () => act(item.key, { type: "restore" }).then(() => undefined);

  const done = () => run(async () => (await act(item.key, { type: "done" }), say("Marked done", undo)));
  const pin = () =>
    run(async () => (await act(item.key, { type: "pin" }), say("On Today, at the bottom of your list")));
  const snooze = (label: string, until: string) =>
    run(async () => {
      await act(item.key, { type: "snooze", until });
      setPanel(null);
      say(`Snoozed until ${label.toLowerCase()}`, undo);
    });
  const dismiss = (reason: DismissReason, confirmed = false) =>
    run(async () => {
      const need = await act(item.key, { type: "dismiss", reason, confirmed });
      if (need) return setPanel({ confirm: need, mode: "dismiss", reason });
      setPanel(null);
      say(`Dismissed: ${DISMISS_REASONS.find((r) => r.value === reason)?.label}. Restore it from Dismissed.`, undo);
    });
  const muteKind = (confirmed = false) =>
    run(async () => {
      const need = await mute(item, confirmed);
      if (need) return setPanel({ confirm: need, mode: "mute" });
      setPanel(null);
      say("Muted");
    });
  const talkTo = (id: string, name: string) =>
    run(async () => {
      const saved = await change({ op: "addItem", id, item: { key: item.key, title: item.title, evidence: item.evidence, detail: item.detail } });
      setPanel(null);
      say(saved ? `Added to ${name}'s agenda` : "That didn't save");
    });

  const more = (
    <button className="btn sm ghost" type="button" aria-label="More actions" onClick={() => toggle("more")}>
      ⋯
    </button>
  );
  const acts =
    ctx === "area" ? (
      <>
        {item.band !== "today" && (
          <button className="btn sm primary" type="button" onClick={pin}>
            → Today
          </button>
        )}
        <button className="btn sm" type="button" onClick={done}>
          Done
        </button>
        {more}
      </>
    ) : ctx === "new" ? (
      <>
        <button className="btn sm primary" type="button" onClick={pin}>
          Add to my list
        </button>
        <button className="btn sm" type="button" onClick={() => toggle("snooze")}>
          Snooze
        </button>
        {more}
      </>
    ) : (
      <>
        <button className="btn sm" type="button" onClick={done}>
          Done
        </button>
        <button className="btn sm" type="button" onClick={() => toggle("snooze")}>
          Snooze
        </button>
        {more}
      </>
    );

  const kind = KIND[item.detector] ?? item.detector;
  return (
    <div className={`item ${SEV_CLASS[item.severity]}`} data-key={item.key} style={busy ? { opacity: 0.5 } : undefined}>
      <div className="row">
        {ctx === "today" && (
          <>
            <button className="grip" aria-label="Drag to reorder" type="button">
              ⠿
            </button>
            <span className="rank">{n}</span>
          </>
        )}
        {ctx === "new" && (
          <button className="grip" aria-label="Drag into my list" type="button">
            ⠿
          </button>
        )}
        <div className="body">
          <div className="title" onClick={() => setOpen(item)}>
            {item.title}
          </div>
          <div className="meta">
            <Tags item={item} ctx={ctx} />
          </div>
          {(item.detail || item.evidence) && (
            <div className="evidence">{[item.detail, item.evidence].filter(Boolean).join(" ")}</div>
          )}
          {item.action && <div className="evidence">→ {item.action}</div>}
        </div>
        <div className="acts">{acts}</div>
      </div>

      {panel === "snooze" && (
        <div className="panel">
          <span className="lbl">Snooze until</span>
          <div className="chips">
            {SNOOZE.map(([label, until]) => (
              <button key={label} className="btn" type="button" onClick={() => snooze(label, until())}>
                {label}
              </button>
            ))}
          </div>
          <span className="lbl soft">It also comes back early if something new happens.</span>
        </div>
      )}

      {panel === "more" && (
        <div className="panel">
          <span className="lbl">Dismiss: why is this noise?</span>
          <div className="chips">
            {DISMISS_REASONS.map((r) => (
              <button key={r.value} className="btn" type="button" onClick={() => dismiss(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
          <span className="lbl">Or stop showing this kind</span>
          <div className="chips">
            <button className="btn" type="button" onClick={() => muteKind()}>
              Mute &ldquo;{kind}
              {item.customer || item.phone ? ` for ${item.customer ?? item.phone}` : ""}&rdquo;
            </button>
          </div>
          {people.length > 0 && (
            <>
              <span className="lbl">Or talk to someone about it</span>
              <div className="chips">
                {people.map((p) => (
                  <button key={p.id} className="btn" type="button" onClick={() => talkTo(p.id, p.name)}>
                    → {p.name}&rsquo;s agenda
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="chips">
            {item.customer && (
              <Link className="btn" href={customerHref(item.customer)}>
                Open customer page
              </Link>
            )}
            {item.band === "today" && (
              <button className="btn" type="button" onClick={() => run(() => act(item.key, { type: "unpin" }))}>
                Take off Today
              </button>
            )}
            <button className="btn" type="button" onClick={() => setOpen(item)}>
              Details and history
            </button>
          </div>
        </div>
      )}

      {panel && typeof panel === "object" && (
        <div className="panel">
          <div className="confirmbox">
            <div>
              <b>This is {panel.confirm === "money" ? "a money item" : "a legal or compliance item"}.</b>{" "}
              {panel.mode === "mute" ? `Mute all "${kind}" items` : "Dismiss this"} anyway?
            </div>
            <div className="note" style={{ background: "transparent", padding: 0 }}>
              It moves to Dismissed, where you can restore it. It comes back on its own if the facts change.
            </div>
            <div className="chips">
              <button
                className="btn dark"
                type="button"
                onClick={() => (panel.mode === "mute" ? muteKind(true) : dismiss(panel.reason ?? "other", true))}
              >
                Yes, {panel.mode}
              </button>
              <button className="btn" type="button" onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Today's "My order" list: drag ⠿ to reorder, and items dragged in from New land here. */
export function SortableList({
  id,
  items,
  ctx,
  empty,
  onOrder,
  group,
}: {
  id: string;
  items: Item[];
  ctx: "today" | "new";
  empty: string;
  onOrder?: (keys: string[]) => void;
  group: { pull: boolean; put: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onOrderRef = useRef(onOrder);
  onOrderRef.current = onOrder;
  useEffect(() => {
    if (!ref.current) return;
    const sync = (evt: Sortable.SortableEvent) => {
      const keys = Array.from(evt.to.querySelectorAll<HTMLElement>(":scope > .item")).map((el) => el.dataset.key!);
      // React owns the DOM: put the moved node back and let the reload re-render it.
      evt.item.remove();
      evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex ?? 0] ?? null);
      onOrderRef.current?.(keys);
    };
    const s = Sortable.create(ref.current, {
      handle: ".grip",
      animation: 150,
      // Pointer events rather than native drag and drop: same on mouse and touch.
      forceFallback: true,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      filter: ".empty",
      sort: ctx === "today",
      group: { name: "today", pull: group.pull, put: group.put },
      onEnd: (evt) => evt.from === evt.to && ctx === "today" && sync(evt),
      onAdd: sync,
    });
    return () => s.destroy();
  }, [ctx, group.pull, group.put]);

  return (
    <div className="list" id={id} ref={ref}>
      {items.length ? (
        items.map((i, n) => <ItemCard key={i.key} item={i} ctx={ctx} n={n + 1} />)
      ) : (
        <div className="empty">{empty}</div>
      )}
    </div>
  );
}

/** An area's open items, new first, the top few until expanded ("Needs attention" on each area page). */
export function NeedsAttention({ areas, limit = 5 }: { areas: Array<Item["area"]>; limit?: number }) {
  const { view, error } = useItems();
  const [all, setAll] = useState(false);
  if (!view) return <div className="empty">{error || "Loading items…"}</div>;
  const list = view.items.filter((i) => areas.includes(i.area) && i.lane !== "confirm");
  list.sort((a, b) => Number(b.band === "new") - Number(a.band === "new"));
  return (
    <section className="sec">
      <div className="sec-h">
        <h2>Needs attention · {list.length}</h2>
        <span className="hint">→ Today puts it at the bottom of your list</span>
      </div>
      <div className="list">
        {list.length ? (
          (all ? list : list.slice(0, limit)).map((i) => <ItemCard key={i.key} item={i} ctx="area" />)
        ) : (
          <div className="empty">Nothing here needs you.</div>
        )}
      </div>
      {list.length > limit && (
        <div>
          <button className="btn sm" type="button" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${list.length}`}
          </button>
        </div>
      )}
    </section>
  );
}

export function Drawer() {
  const { open, setOpen, act, say } = useItems();
  const pathname = usePathname();
  useEffect(() => setOpen(null), [pathname, setOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);
  if (!open) return null;
  const i = open;
  const status = i.band === "today" ? "On Today" : i.band === "new" ? "New" : "Open";
  return (
    <>
      <div className="scrim" onClick={() => setOpen(null)} />
      <aside className="drawer" role="dialog" aria-label="Item details">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <h2>{i.title}</h2>
          <button className="btn sm" type="button" onClick={() => setOpen(null)}>
            Close
          </button>
        </div>
        <div className="meta" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <Tags item={i} ctx="today" />
        </div>
        {(i.detail || i.evidence) && <div>{[i.detail, i.evidence].filter(Boolean).join(" ")}</div>}
        <dl className="kv">
          <dt>Status</dt>
          <dd>{status}</dd>
          {i.action && (
            <>
              <dt>Next step</dt>
              <dd>{i.action}</dd>
            </>
          )}
          <dt>Detected by</dt>
          <dd>
            {KIND[i.detector] ?? i.detector} ({i.detector})
          </dd>
          <dt>Comes back if</dt>
          <dd>The facts behind it change</dd>
          <dt>Area</dt>
          <dd>{AREA_LABEL[RAIL_AREA[i.area]]}</dd>
          <dt>History</dt>
          <dd>
            First seen {ago(i.state.firstSeenAt)}
            {i.state.pinnedSince ? `, on Today since ${i.state.pinnedSince}` : ""}
            {i.state.reopenedAt ? `, reopened ${ago(i.state.reopenedAt)}` : ""}.
          </dd>
        </dl>
        <div className="chips">
          {i.band !== "today" && (
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                await act(i.key, { type: "pin" });
                setOpen(null);
                say("On Today, at the bottom of your list");
              }}
            >
              → Today
            </button>
          )}
          {i.customer && (
            <Link className="btn" href={customerHref(i.customer)} onClick={() => setOpen(null)}>
              Open customer page
            </Link>
          )}
          {i.link && (
            <a className="btn" href={i.link} target="_blank" rel="noreferrer">
              Open source
            </a>
          )}
        </div>
      </aside>
    </>
  );
}

export function ToastHost() {
  const { toast, say } = useItems();
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.msg}</span>
      {toast.undo && (
        <button
          type="button"
          onClick={async () => {
            await toast.undo!();
            say("Undone");
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
