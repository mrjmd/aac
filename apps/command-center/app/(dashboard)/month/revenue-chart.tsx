import { CHART_FROM, CHART_TO, DECISION_WINDOW, monthsBetween, type RevenueMonth } from "@aac/metrics";

/** The mockup's revenue chart: monthly bars, last year behind them, the rolling 3-month line, floor and target, the decision window. */
export function RevenueChart({ months, floor, target }: { months: RevenueMonth[]; floor: number; target: number }) {
  const slots = monthsBetween(CHART_FROM, CHART_TO);
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const W = 720;
  const H = 240;
  const L = 34;
  const R = 10;
  const T = 14;
  const B = 34;
  const peak = Math.max(target, ...months.flatMap((m) => [m.revenue, m.lastYear ?? 0]));
  const max = Math.ceil((peak * 1.1) / 10_000) * 10_000;
  const bw = (W - L - R) / slots.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const x = (i: number) => L + i * bw;
  const win = slots.indexOf(DECISION_WINDOW[0]);
  const grid = Array.from({ length: Math.floor(max / 20_000) + 1 }, (_, k) => k * 20_000);
  const line = slots
    .map((m, i) => ({ i, v: byMonth.get(m)?.rolling3 }))
    .filter((p): p is { i: number; v: number } => p.v != null)
    .map((p) => [x(p.i) + bw / 2, y(p.v)] as const);
  const last = line[line.length - 1];
  const label = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) + (m.endsWith("-01") ? ` ${m.slice(2, 4)}` : "");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Monthly revenue and rolling 3-month average against the charter floor and target">
      {win >= 0 && (
        <>
          <rect x={x(win)} y={T} width={3 * bw} height={H - T - B} fill="var(--hl-soft)" />
          <text x={x(win) + 1.5 * bw} y={T + 12} textAnchor="middle">
            Decision window
          </text>
        </>
      )}
      {grid.map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="var(--sunk)" strokeWidth={1.5} />
          <text x={L - 6} y={y(g) + 3} textAnchor="end">
            {g / 1000}k
          </text>
        </g>
      ))}
      {slots.map((m, i) => {
        const d = byMonth.get(m);
        if (!d) return null;
        return (
          <g key={m}>
            <title>{`${m}: $${d.revenue.toLocaleString("en-US")}${d.lastYear != null ? `, last year $${d.lastYear.toLocaleString("en-US")}` : ""}${d.rolling3 != null ? `, 3-mo avg $${d.rolling3.toLocaleString("en-US")}` : ""}${d.open ? " (month still open)" : ""}`}</title>
            {d.lastYear != null && <rect x={x(i) + bw * 0.1} y={y(d.lastYear)} width={bw * 0.8} height={y(0) - y(d.lastYear)} rx={2} fill="var(--sunk)" />}
            <rect
              x={x(i) + bw * 0.18}
              y={y(d.revenue)}
              width={bw * 0.64}
              height={y(0) - y(d.revenue)}
              rx={2}
              fill={d.open ? "none" : "#cfe1f3"}
              stroke={d.open ? "#9fc3e6" : "none"}
              strokeDasharray={d.open ? "3 2" : undefined}
            />
          </g>
        );
      })}
      {line.length > 1 && (
        <polyline fill="none" stroke="var(--accent)" strokeWidth={2.5} points={line.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} />
      )}
      {last && <circle cx={last[0]} cy={last[1]} r={4.5} fill="var(--accent)" stroke="#fff" strokeWidth={2} />}
      <line x1={L} x2={W - R} y1={y(floor)} y2={y(floor)} stroke="var(--red)" strokeDasharray="5 4" strokeWidth={1.4} />
      <text x={L + 4} y={y(floor) - 4} textAnchor="start" style={{ fill: "var(--red)" }}>
        Floor ${floor / 1000}k
      </text>
      <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} stroke="var(--green)" strokeDasharray="5 4" strokeWidth={1.4} />
      <text x={L + 4} y={y(target) - 4} textAnchor="start" style={{ fill: "var(--green)" }}>
        Target ${target / 1000}k
      </text>
      {slots.map((m, i) =>
        i % 2 === 0 ? (
          <text key={m} x={x(i) + bw / 2} y={H - B + 14} textAnchor="middle">
            {label(m)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
