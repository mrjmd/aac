"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import type { RowFormat, ScoreRecord, ScoreRow } from "@aac/metrics";
import type { ScorecardView } from "@/lib/scorecard-view";
import { customerHref } from "../components/items";

type Pick = { row: ScoreRow; week: number | "ly"; label: string };

const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function show(v: number, fmt: RowFormat): string {
  switch (fmt) {
    case "hours":
    case "weeks":
      return v.toFixed(1);
    case "pct":
      return `${v}%`;
    case "usdk":
      return `$${v.toFixed(1)}k`;
    case "usd":
      return `$${Math.round(v).toLocaleString("en-US")}`;
    default:
      return String(v);
  }
}

/** One cell: green ✓ or red ✕ against that week's target, plain when there's no goal or the week isn't over. */
function Cell({
  row,
  v,
  target,
  judge,
  on,
  open,
}: {
  row: ScoreRow;
  v: number | null;
  target: number | null;
  judge: boolean;
  on?: boolean;
  open?: () => void;
}) {
  if (v == null) return <span className="cell na">n/a</span>;
  const ok = target == null || !judge ? null : row.dir > 0 ? v >= target : v <= target;
  const body = (
    <>
      {ok != null && <span className="m">{ok ? "✓" : "✕"}</span>}
      {show(v, row.fmt)}
    </>
  );
  const cls = `cell${ok == null ? "" : ok ? " ok" : " off"}${on ? " sel" : ""}`;
  return open ? (
    <button type="button" className={`${cls} drill`} onClick={open} aria-pressed={on} title="See what this counts">
      {body}
    </button>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** The records behind the picked cell, under the table. */
function Records({ pick, close }: { pick: Pick; close: () => void }) {
  const [state, setState] = useState<{ key: string; records: ScoreRecord[] | null; error?: string } | null>(null);
  const key = `${pick.row.key}|${pick.week}`;
  useEffect(() => {
    let live = true;
    fetch(`/api/scorecard/records?row=${encodeURIComponent(pick.row.key)}&week=${pick.week}`)
      .then(async (res) => {
        const json = (await res.json()) as { records?: ScoreRecord[] | null; error?: string };
        if (live) setState({ key, records: json.records ?? null, ...(res.ok ? {} : { error: json.error ?? "Couldn't load" }) });
      })
      .catch(() => live && setState({ key, records: null, error: "Couldn't load" }));
    return () => {
      live = false;
    };
  }, [key, pick.row.key, pick.week]);
  const records = state?.key === key ? state.records : undefined;
  return (
    <div className="drill-panel">
      <div className="sec-h">
        <h3>
          {pick.row.name}, {pick.label}
          {records ? ` · ${records.length}` : ""}
        </h3>
        <button className="btn sm" type="button" onClick={close}>
          Close
        </button>
      </div>
      {records === undefined ? (
        <div className="empty">Loading…</div>
      ) : state?.error ? (
        <div className="empty">{state.error}</div>
      ) : !records ? (
        <div className="empty">Records start with tomorrow&apos;s nightly build.</div>
      ) : !records.length ? (
        <div className="empty">Nothing counted this week.</div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <tbody>
              {records.map((r, n) => (
                <tr key={n}>
                  <td className="num" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {r.day ? fmtDay(r.day) : ""}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{r.customer ? <Link href={customerHref(r.customer)}>{r.label}</Link> : r.label}</td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {r.value ?? ""}
                  </td>
                  <td style={{ whiteSpace: "normal", color: "var(--muted)" }}>{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="note">{pick.row.info}</div>
    </div>
  );
}

/** The 13-week scorecard (mockup's This week). Cells are for reading trends; they never become items. */
export function ScorecardCard({ card }: { card: ScorecardView | null }) {
  const [pick, setPick] = useState<Pick | null>(null);
  if (!card) {
    return (
      <div className="card">
        <h3>Scorecard, last 13 weeks</h3>
        <div className="empty">Not built yet. The worker builds it every night.</div>
      </div>
    );
  }
  const last = card.weeks.length - 1;
  const built = new Date(card.builtAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="card">
      <div className="sec-h">
        <h3>Scorecard, last 13 weeks</h3>
        <span className="hint">Built {built}, nightly</span>
      </div>
      {card.gaps.length > 0 && <div className="callout">Missing: {card.gaps.join("; ")}</div>}
      <div className="tbl-wrap">
        <table className="score">
          <thead>
            <tr>
              <th className="name">Measure</th>
              <th>Goal</th>
              {card.weeks.map((w, k) => (
                <th key={w} className={k === last - 1 ? "cur" : ""}>
                  {k === last ? "This wk" : fmtDay(w)}
                </th>
              ))}
              <th title="The same week a year earlier">Last yr</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((r) => {
              // Snapshots saved before seasonal targets have no `targets`: judge against the flat goal.
              const target = (k: number) => r.targets?.[k] ?? r.goal;
              const sign = r.dir > 0 ? "≥" : "≤";
              return (
                <Fragment key={r.key}>
                  <tr className={r.seasonal ? "has-target" : ""}>
                    <td className="name" title={r.info}>
                      {r.name}
                    </td>
                    <td className="goal num" title={r.seasonal ? "Average week; each week's target follows the season" : undefined}>
                      {r.goal == null ? "" : `${sign} ${show(r.goal, r.fmt)}${r.seasonal ? " avg" : ""}`}
                    </td>
                    {r.values.map((v, k) => (
                      <td key={card.weeks[k]} className={k === last - 1 ? "cur" : ""}>
                        <Cell
                          row={r}
                          v={v}
                          target={target(k)}
                          judge={k < last}
                          on={pick?.row.key === r.key && pick.week === k}
                          open={card.drill ? () => setPick({ row: r, week: k, label: k === last ? "this week so far" : `week of ${fmtDay(card.weeks[k]!)}` }) : undefined}
                        />
                      </td>
                    ))}
                    <td>
                      <Cell
                        row={r}
                        v={r.lastYear}
                        target={null}
                        judge={false}
                        on={pick?.row.key === r.key && pick.week === "ly"}
                        open={card.drill ? () => setPick({ row: r, week: "ly", label: "same week last year" }) : undefined}
                      />
                    </td>
                  </tr>
                  {r.seasonal && (
                    <tr className="target">
                      <td className="name">Target, seasonal</td>
                      <td />
                      {card.weeks.map((w, k) => (
                        <td key={w} className={k === last - 1 ? "cur" : ""}>
                          {target(k) == null ? "" : show(target(k)!, r.fmt)}
                        </td>
                      ))}
                      <td>{r.lastYearTarget == null ? "" : show(r.lastYearTarget, r.fmt)}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {pick && <Records pick={pick} close={() => setPick(null)} />}
      <div className="note">
        {card.drill ? "Tap any number to see what it counts. " : ""}The highlighted column is the week that just closed. This week so far isn&apos;t judged until it ends. Volume rows
        are judged against a seasonal target: the average week&apos;s goal times that month&apos;s index from the funnel study
        (re-fit each January); payments in follows it half a month late. Rates and speeds keep one goal all year. Goals are a first draft from the Aug-Oct
        baselines; tell me what to change.
      </div>
      <details className="fold">
        <summary>How each row is counted</summary>
        <dl className="kv" style={{ marginTop: 8, gridTemplateColumns: "minmax(120px, 220px) minmax(0, 1fr)" }}>
          {card.rows.map((r) => (
            <div key={r.key} style={{ display: "contents" }}>
              <dt>{r.name}</dt>
              <dd>{r.info}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
