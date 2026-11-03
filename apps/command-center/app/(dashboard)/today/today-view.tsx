"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, RotateCcw } from "lucide-react";
import { cn } from "@aac/ui";
import type { DismissReason, Item, ItemState, Lane, Verb } from "@aac/items";

interface ItemsView {
  detectedAt: string | null;
  source: string | null;
  items: Item[];
  hiddenCounts: Record<string, number>;
  dismissed: ItemState[];
}

const AREA_LABEL: Record<string, string> = {
  money: "Money",
  sales: "Sales",
  jobs: "Jobs",
  inbox: "Inbox",
  marketing: "Marketing",
  admin: "Admin and your to-dos",
  system: "System",
};
const AREA_ORDER = ["admin", "money", "jobs", "sales", "inbox", "marketing", "system"];

const SEVERITY = {
  red: { label: "Urgent", dot: "bg-red-500", text: "text-red-700" },
  yellow: { label: "Soon", dot: "bg-amber-400", text: "text-amber-700" },
  info: { label: "FYI", dot: "bg-zinc-300", text: "text-zinc-500" },
} as const;

const DISMISS_REASONS: Array<{ value: DismissReason; label: string }> = [
  { value: "already-handled", label: "Already handled" },
  { value: "not-real", label: "Not real" },
  { value: "not-mine", label: "Not mine" },
  { value: "wrong-match", label: "Wrong match" },
  { value: "other", label: "Other" },
];

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function snoozeUntil(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(7, 0, 0, 0);
  return d.toISOString();
}

function ago(iso: string): string {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function TodayView() {
  const [view, setView] = useState<ItemsView | null>(null);
  const [error, setError] = useState("");
  const [lane, setLane] = useState<Lane>("needs-you");

  const load = useCallback(async () => {
    const res = await fetch("/api/items", { cache: "no-store" });
    if (!res.ok) {
      setError(`Couldn't load items (${res.status})`);
      return;
    }
    setError("");
    setView((await res.json()) as ItemsView);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Returns the confirm kind when the server wants a confirmation. */
  const act = useCallback(
    async (key: string, verb: Verb): Promise<"money" | "legal" | null> => {
      const res = await fetch("/api/items/verb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, verb }),
      });
      if (res.status === 409) return ((await res.json()) as { confirm: "money" | "legal" }).confirm;
      if (!res.ok) setError(`That didn't save (${res.status})`);
      await load();
      return null;
    },
    [load],
  );

  const mute = useCallback(
    async (item: Item, confirmed = false): Promise<"money" | "legal" | null> => {
      const res = await fetch("/api/items/mutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detector: item.detector, match: item.customer ?? item.phone, confirmed }),
      });
      if (res.status === 409) return ((await res.json()) as { confirm: "money" | "legal" }).confirm;
      await load();
      return null;
    },
    [load],
  );

  const move = useCallback(
    async (todayKeys: string[], index: number, delta: number) => {
      const next = [...todayKeys];
      const [k] = next.splice(index, 1);
      next.splice(index + delta, 0, k);
      await fetch("/api/items/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: next }),
      });
      await load();
    },
    [load],
  );

  const laneItems = useMemo(() => view?.items.filter((i) => i.lane === lane) ?? [], [view, lane]);
  const counts = useMemo(() => {
    const c = { "needs-you": 0, confirm: 0 };
    for (const i of view?.items ?? []) c[i.lane] += 1;
    return c;
  }, [view]);

  if (!view) {
    return <p className="text-sm text-zinc-400">{error || "Loading…"}</p>;
  }

  const today = laneItems.filter((i) => i.band === "today");
  const fresh = laneItems.filter((i) => i.band === "new");
  const rest = laneItems.filter((i) => i.band === "list");
  const todayKeys = today.map((i) => i.key);
  const staleData = view.detectedAt && Date.now() - Date.parse(view.detectedAt) > 26 * 3_600_000;

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Today</h1>
        <p className={cn("mt-1 text-xs", staleData ? "font-semibold text-red-600" : "text-zinc-400")}>
          {view.detectedAt
            ? `Checked ${ago(view.detectedAt)} (${view.source ?? "unknown"})${staleData ? ", the detectors haven't run in over a day" : ""}`
            : "No detector run yet"}
        </p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </header>

      <div className="mb-5 inline-flex rounded-lg border border-zinc-200 bg-white p-1 text-sm">
        {(["needs-you", "confirm"] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLane(l)}
            className={cn(
              "rounded-md px-3 py-1.5 font-semibold transition-colors",
              lane === l ? "bg-aac-blue text-white" : "text-zinc-500 hover:text-aac-dark",
            )}
          >
            {l === "needs-you" ? "Needs you" : "Automation, confirm"} ({counts[l]})
          </button>
        ))}
      </div>

      <Section title="On Today" count={today.length} empty="Nothing pinned. Use → Today on anything below.">
        {today.map((item, i) => (
          <ItemRow
            key={item.key}
            item={item}
            act={act}
            mute={mute}
            reorder={
              <div className="flex flex-col">
                <IconButton label="Move up" disabled={i === 0} onClick={() => move(todayKeys, i, -1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label="Move down" disabled={i === today.length - 1} onClick={() => move(todayKeys, i, 1)}>
                  <ArrowDown size={14} />
                </IconButton>
              </div>
            }
          />
        ))}
      </Section>

      <Section title="New since you looked" count={fresh.length} empty="You're caught up.">
        {fresh.map((item) => (
          <ItemRow key={item.key} item={item} act={act} mute={mute} />
        ))}
      </Section>

      {AREA_ORDER.filter((a) => rest.some((i) => i.area === a)).map((area) => {
        const items = rest.filter((i) => i.area === area);
        return (
          <details key={area} className="mb-3 rounded-xl border border-zinc-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-aac-dark">
              {AREA_LABEL[area]} <span className="font-normal text-zinc-400">({items.length})</span>
            </summary>
            <div className="divide-y divide-zinc-100 border-t border-zinc-100">
              {items.map((item) => (
                <ItemRow key={item.key} item={item} act={act} mute={mute} bare />
              ))}
            </div>
          </details>
        );
      })}

      <footer className="mt-8 space-y-3 text-xs text-zinc-400">
        <p>
          Hidden: {view.hiddenCounts.done ?? 0} done, {view.hiddenCounts.snoozed ?? 0} snoozed,{" "}
          {view.hiddenCounts.dismissed ?? 0} dismissed, {view.hiddenCounts.muted ?? 0} muted.
        </p>
        {view.dismissed.length > 0 && (
          <details className="rounded-xl border border-zinc-200 bg-white text-sm text-aac-dark">
            <summary className="cursor-pointer px-4 py-3 font-semibold">
              Dismissed, last 30 days <span className="font-normal text-zinc-400">({view.dismissed.length})</span>
            </summary>
            <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
              {view.dismissed.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="block truncate">{s.snapshot?.title ?? s.key}</span>
                    <span className="text-xs text-zinc-400">
                      {DISMISS_REASONS.find((r) => r.value === s.dismissReason)?.label ?? "Dismissed"}
                      {s.actedAt ? `, ${ago(s.actedAt)}` : ""}
                    </span>
                  </span>
                  <button
                    onClick={() => act(s.key, { type: "restore" })}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs font-semibold hover:border-aac-blue"
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </footer>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
        {title} <span className="font-normal">({count})</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-3 text-sm text-zinc-400">{empty}</p>
      ) : (
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">{children}</div>
      )}
    </section>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-zinc-400 hover:text-aac-blue disabled:opacity-30"
    >
      {children}
    </button>
  );
}

type Panel = null | "snooze" | "dismiss" | { confirm: "money" | "legal"; then: "dismiss" | "mute"; reason?: DismissReason };

function ItemRow({
  item,
  act,
  mute,
  reorder,
  bare,
}: {
  item: Item;
  act: (key: string, verb: Verb) => Promise<"money" | "legal" | null>;
  mute: (item: Item, confirmed?: boolean) => Promise<"money" | "legal" | null>;
  reorder?: React.ReactNode;
  bare?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const sev = SEVERITY[item.severity];
  const onToday = item.band === "today";

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = (reason: DismissReason, confirmed = false) =>
    run(async () => {
      const need = await act(item.key, { type: "dismiss", reason, confirmed });
      setPanel(need ? { confirm: need, then: "dismiss", reason } : null);
    });

  const muteKind = (confirmed = false) =>
    run(async () => {
      const need = await mute(item, confirmed);
      setPanel(need ? { confirm: need, then: "mute" } : null);
    });

  return (
    <div className={cn("flex gap-3 px-4 py-3", busy && "opacity-50", bare && "bg-white")}>
      {reorder}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", sev.dot)} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-aac-dark">
              {item.title}
              {item.link && (
                <a href={item.link} target="_blank" rel="noreferrer" className="ml-1 inline-block text-zinc-400 hover:text-aac-blue">
                  <ExternalLink size={12} />
                </a>
              )}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              <span className={cn("font-semibold", sev.text)}>{sev.label}</span>
              {item.customer && (
                <>
                  {" · "}
                  <a href={`/customers?q=${encodeURIComponent(item.customer)}`} className="hover:text-aac-blue hover:underline">
                    {item.customer}
                  </a>
                </>
              )}
              {item.phone && ` · ${item.phone}`}
              {item.amount !== undefined && ` · ${money(item.amount)}`}
              {` · ${item.detector}`}
              {item.state.reopenedAt && " · back: new evidence"}
              {item.rolloverDays !== undefined && item.rolloverDays >= 3 && (
                <span className="font-semibold text-amber-700">
                  {` · on Today ${item.rolloverDays} days: do it, schedule it, or let it go`}
                </span>
              )}
            </p>
            {item.detail && <p className="mt-1 text-xs text-zinc-600">{item.detail}</p>}
            {item.evidence && <p className="mt-1 text-xs italic text-zinc-400">{item.evidence}</p>}
            {item.action && <p className="mt-1 text-xs font-medium text-aac-blue">→ {item.action}</p>}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
          <Chip onClick={() => run(() => act(item.key, { type: "done" }))}>Done</Chip>
          {onToday ? (
            <Chip onClick={() => run(() => act(item.key, { type: "unpin" }))}>Off Today</Chip>
          ) : (
            <Chip onClick={() => run(() => act(item.key, { type: "pin" }))}>→ Today</Chip>
          )}
          {item.band === "new" && <Chip onClick={() => run(() => act(item.key, { type: "place" }))}>Keep in list</Chip>}
          <Chip active={panel === "snooze"} onClick={() => setPanel(panel === "snooze" ? null : "snooze")}>
            Snooze
          </Chip>
          <Chip active={panel === "dismiss"} onClick={() => setPanel(panel === "dismiss" ? null : "dismiss")}>
            Dismiss
          </Chip>
        </div>

        {panel === "snooze" && (
          <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
            {[
              ["Tomorrow", 1],
              ["3 days", 3],
              ["Next week", 7],
            ].map(([label, days]) => (
              <Chip
                key={label}
                onClick={() =>
                  run(async () => {
                    await act(item.key, { type: "snooze", until: snoozeUntil(days as number) });
                    setPanel(null);
                  })
                }
              >
                {label}
              </Chip>
            ))}
          </div>
        )}

        {panel === "dismiss" && (
          <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
            {DISMISS_REASONS.map((r) => (
              <Chip key={r.value} onClick={() => dismiss(r.value)}>
                {r.label}
              </Chip>
            ))}
            <Chip onClick={() => muteKind()}>
              Mute all {item.detector}
              {item.customer || item.phone ? ` for ${item.customer ?? item.phone}` : ""}
            </Chip>
          </div>
        )}

        {panel && typeof panel === "object" && (
          <div className="mt-2 ml-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This is a {panel.confirm} item. You may have handled it somewhere the system can&apos;t see.{" "}
            {panel.then === "dismiss" ? "Dismiss" : "Mute"} anyway?
            <span className="ml-2 inline-flex gap-1.5">
              <Chip
                onClick={() => (panel.then === "dismiss" ? dismiss(panel.reason ?? "other", true) : muteKind(true))}
              >
                Yes
              </Chip>
              <Chip onClick={() => setPanel(null)}>Cancel</Chip>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-xs font-semibold transition-colors",
        active ? "border-aac-blue bg-aac-blue/10 text-aac-blue" : "border-zinc-200 text-zinc-600 hover:border-aac-blue hover:text-aac-blue",
      )}
    >
      {children}
    </button>
  );
}
