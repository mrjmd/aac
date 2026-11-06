import { Fragment } from "react";
import type { RowFormat, ScoreRow, Scorecard } from "@aac/metrics";

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
function Cell({ row, v, target, judge }: { row: ScoreRow; v: number | null; target: number | null; judge: boolean }) {
  if (v == null) return <span className="cell na">n/a</span>;
  if (target == null || !judge) return <span className="cell">{show(v, row.fmt)}</span>;
  const ok = row.dir > 0 ? v >= target : v <= target;
  return (
    <span className={`cell ${ok ? "ok" : "off"}`}>
      <span className="m">{ok ? "✓" : "✕"}</span>
      {show(v, row.fmt)}
    </span>
  );
}

/** The 13-week scorecard (mockup's This week). Cells are for reading trends; they never become items. */
export function ScorecardCard({ card }: { card: Scorecard | null }) {
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
                        <Cell row={r} v={v} target={target(k)} judge={k < last} />
                      </td>
                    ))}
                    <td>
                      <Cell row={r} v={r.lastYear} target={null} judge={false} />
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
      <div className="note">
        The highlighted column is the week that just closed. This week so far isn&apos;t judged until it ends. Volume rows
        are judged against a seasonal target: the average week&apos;s goal times that month&apos;s index from the funnel study
        (re-fit each January). Rates, speeds and payments in keep one goal all year. Goals are a first draft from the Aug-Oct
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
