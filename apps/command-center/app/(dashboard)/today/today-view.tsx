"use client";

import Link from "next/link";
import type { FieldEvent } from "@/lib/field-events";
import { ago, customerHref, SortableList } from "../components/items";
import { Glance, OverviewTabs, PageHeader } from "../components/layout-parts";
import { useItems } from "../items-context";

const DISMISS_LABEL: Record<string, string> = {
  "not-real": "Not real",
  "already-handled": "Handled elsewhere",
  "not-mine": "Not mine",
  "wrong-match": "Wrong customer match",
  other: "Other",
};

function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

export function TodayView({
  today,
  glance,
  jobs,
  techOut,
}: {
  today: string;
  glance: Array<[string, string]>;
  jobs: FieldEvent[];
  techOut: boolean;
}) {
  const { view, error, act, reorder, say } = useItems();

  const items = view?.items ?? [];
  const fresh = items.filter((i) => i.band === "new" && i.lane !== "confirm");
  const mine = items.filter((i) => i.band === "today" && i.lane !== "confirm");
  const confirm = items.filter((i) => i.lane === "confirm");
  const backlog = items.filter((i) => i.band === "list" && i.lane !== "confirm");
  const stale = view?.detectedAt && Date.now() - Date.parse(view.detectedAt) > 26 * 3_600_000;

  /** Keys dropped into My order: pin the new ones, then save the order. */
  const order = async (keys: string[]) => {
    const added = keys.filter((k) => !mine.some((i) => i.key === k));
    for (const k of added) await act(k, { type: "pin" });
    await reorder(keys);
    if (added.length) say("Added to your list");
  };

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Today"
        sub={
          <span style={stale ? { color: "var(--red)" } : undefined}>
            {longDate(today)}
            {view?.detectedAt
              ? ` · checked ${ago(view.detectedAt)}${stale ? ", the detectors haven't run in over a day" : ""}`
              : view
                ? " · no detector run yet"
                : ""}
          </span>
        }
        right={<OverviewTabs on="/today" />}
      />
      {error && <div className="callout">{error}</div>}

      <div className="glance">
        {glance.map(([k, v]) => (
          <Glance key={k} k={k} v={v} />
        ))}
      </div>
      <div className="jobs-strip">
        {techOut && (
          <span className="jobchip">
            <span className="dot stub" />
            Mike out of office
          </span>
        )}
        {jobs.length ? (
          jobs.map((j) => (
            <a key={j.id} className="jobchip" href={j.href} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>
              <span className={`dot ${j.cls}`} />
              {j.time} {j.title}
              {j.town ? `, ${j.town}` : ""}
            </a>
          ))
        ) : techOut ? null : (
          <span className="jobchip" style={{ color: "var(--muted)" }}>
            Nothing on the field calendar today
          </span>
        )}
      </div>

      {!view ? (
        <div className="empty">Loading items…</div>
      ) : (
        <>
          <section className="sec band-new">
            <div className="sec-h">
              <h2>New since you looked · {fresh.length}</h2>
              <span className="hint">Drag into your list, add it, or dismiss it. Nothing here moves your order.</span>
            </div>
            <SortableList id="newlist" items={fresh} ctx="new" empty="Nothing new. Quiet is good." group={{ pull: true, put: false }} />
          </section>

          <section className="sec">
            <div className="sec-h">
              <h2>My order · {mine.length}</h2>
              <span className="hint">Drag ⠿ to reorder. Your order stays put.</span>
            </div>
            <SortableList
              id="mylist"
              items={mine}
              ctx="today"
              empty={
                backlog.length
                  ? `Your list is clear. ${backlog.length} open items sit in the areas; → Today pulls one here.`
                  : "Your list is clear."
              }
              onOrder={order}
              group={{ pull: false, put: true }}
            />
          </section>

          <section className="sec">
            <div className="sec-h">
              <h2>Automation did this, confirm · {confirm.length}</h2>
              <span className="hint">Review lane. Separate from your work.</span>
            </div>
            {confirm.length ? (
              <div className="confirm">
                {confirm.map((i) => (
                  <div key={i.key} className="ccard">
                    <div className="t">{i.title}</div>
                    <div className="d">{[i.detail, i.evidence].filter(Boolean).join(" ")}</div>
                    <div className="a">
                      <button
                        className="btn sm primary"
                        type="button"
                        onClick={async () => {
                          await act(i.key, { type: "done" });
                          say("Reviewed", () => act(i.key, { type: "restore" }).then(() => undefined));
                        }}
                      >
                        Reviewed
                      </button>
                      <button
                        className="btn sm"
                        type="button"
                        onClick={async () => {
                          const t = new Date();
                          t.setDate(t.getDate() + 1);
                          t.setHours(7, 0, 0, 0);
                          await act(i.key, { type: "snooze", until: t.toISOString() });
                          say("Snoozed until tomorrow");
                        }}
                      >
                        Tomorrow
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">Nothing waiting on review.</div>
            )}
          </section>

          <details className="fold">
            <summary>Snoozed · {view.snoozed.length}</summary>
            <div className="list">
              {view.snoozed.length ? (
                view.snoozed.map((s) => (
                  <div key={s.key} className="item">
                    <div className="row">
                      <div className="body">
                        <div className="title">{s.title}</div>
                        <div className="meta">
                          {s.customer && (
                            <Link className="tag" href={customerHref(s.customer)}>
                              {s.customer}
                            </Link>
                          )}
                          {s.until && (
                            <span className="tag">
                              Snoozed until{" "}
                              {new Date(s.until).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric" })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="acts">
                        <button className="btn sm" type="button" onClick={() => act(s.key, { type: "restore" })}>
                          Bring back
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">Nothing snoozed.</div>
              )}
            </div>
          </details>

          <details className="fold">
            <summary>Dismissed, last 30 days · {view.dismissed.length}</summary>
            <div className="list">
              {view.dismissed.length ? (
                view.dismissed.map((s) => (
                  <div key={s.key} className="item">
                    <div className="row">
                      <div className="body">
                        <div className="title">{s.snapshot?.title ?? s.key}</div>
                        <div className="meta">
                          <span className="tag">
                            Dismissed: {DISMISS_LABEL[s.dismissReason ?? "other"] ?? "muted"}
                            {s.actedAt ? `, ${ago(s.actedAt)}` : ""}
                          </span>
                        </div>
                      </div>
                      <div className="acts">
                        <button className="btn sm" type="button" onClick={() => act(s.key, { type: "restore" })}>
                          Restore
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">Nothing dismissed. Anything you dismiss lands here and can be restored.</div>
              )}
            </div>
          </details>
        </>
      )}
    </>
  );
}
