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

/** One cell: green ✓ or red ✕ against the goal, plain when there's no goal or the week isn't over. */
function Cell({ row, v, judge }: { row: ScoreRow; v: number | null; judge: boolean }) {
  if (v == null) return <span className="cell na">n/a</span>;
  if (row.goal == null || !judge) return <span className="cell">{show(v, row.fmt)}</span>;
  const ok = row.dir > 0 ? v >= row.goal : v <= row.goal;
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
            {card.rows.map((r) => (
              <tr key={r.key}>
                <td className="name" title={r.info}>
                  {r.name}
                </td>
                <td className="goal num">{r.goal == null ? "" : `${r.dir > 0 ? "≥" : "≤"} ${show(r.goal, r.fmt)}`}</td>
                {r.values.map((v, k) => (
                  <td key={card.weeks[k]} className={k === last - 1 ? "cur" : ""}>
                    <Cell row={r} v={v} judge={k < last} />
                  </td>
                ))}
                <td>
                  <Cell row={r} v={r.lastYear} judge={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note">
        The highlighted column is the week that just closed. This week so far isn&apos;t judged until it ends. Goals are a
        first draft from the Aug-Oct baselines; tell me what to change.
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
