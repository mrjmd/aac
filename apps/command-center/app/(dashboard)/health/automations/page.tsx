import Link from "next/link";
import { BAR, type AutomationStats, type Outcome, type WeekStats } from "@aac/grader";
import { readAutomations, type AutomationView, type AutomationsData, type KindRow } from "@/lib/automations";
import { Glance, PageHeader } from "../../components/layout-parts";
import { SystemTabs } from "../system-tabs";
import { DraftRows, type DraftRowData } from "./draft-rows";

export const dynamic = "force-dynamic";

const PATHS = {
  fast: ["Fast path", "Common and simple. These can earn auto-send first."],
  learn: ["Learnable, slower", "Fewer cases or more variety. Drafts for you until the numbers are there."],
  human: ["Stays with you", "Needs real judgment, a visit, or questions. Always drafts for you; never auto-sends."],
} as const;

const DOT: Record<Outcome, string> = { right: "ok", changed: "chg", "thrown-out": "del", hurt: "del", unused: "nd", waiting: "wait" };
const CALIBRATE = 30;

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}
const money = (v?: number) => (v === undefined ? "n/a" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US")}`);
const phone = (p?: string) => (p ? `(${p.slice(-10, -7)}) ${p.slice(-7, -4)}-${p.slice(-4)}` : "");

function status(v: AutomationView): [string, string] {
  if (v.meta.live) return ["on", "Live"];
  const s = v.stats;
  if (!s || !s.n) return ["nd", s?.drafts ? "Collecting" : "No drafts yet"];
  if (v.ready) return ["on", `${v.ready} kind${v.ready === 1 ? "" : "s"} ready`];
  if (s.n < 10) return ["nd", "Too few"];
  return ["risk", "Learning"];
}

function Meter({ t, small }: { t: { raw: number | null; proven: number }; small?: boolean }) {
  const ok = t.proven >= BAR.proven;
  return (
    <div className="am-track" style={small ? { height: 8 } : undefined}>
      <b style={{ width: `${t.raw ?? 0}%` }} />
      <i className={ok ? "ok" : t.proven >= BAR.proven - 10 ? "mid" : ""} style={{ width: `${t.proven}%` }} />
      <em style={{ left: `${BAR.proven}%` }} title={`Bar: proven ${BAR.proven}%`} />
    </div>
  );
}

function Card({ v, sel }: { v: AutomationView; sel: boolean }) {
  const s = v.stats;
  const [cls, label] = status(v);
  const dots = (s?.recent ?? []).slice(0, 20).reverse();
  return (
    <Link href={`/health/automations?a=${v.meta.id}#detail`} className={`am-auto${sel ? " sel" : ""}`} scroll={false}>
      <div className="hd">
        <b>{v.meta.name}</b>
        <span className={`st ${cls}`}>{label}</span>
      </div>
      <div className="what">{v.meta.what}</div>
      <div className="am-ladder">
        <span className={v.meta.live ? "done" : "now"}>Drafts for you</span>
        <span className={v.meta.live ? "now" : ""}>Does it itself</span>
      </div>
      {v.meta.notMeasured ? (
        <div className="foot">{v.meta.notMeasured}</div>
      ) : (
        <>
          <div className="am-meter">
            <div className="lab">
              <span>{s?.n ? `Proven ${s.proven}%` : "No grades yet"}</span>
              <span>{s?.n ? `raw ${s.raw}% · ${s.k} of ${s.n} right` : ""}</span>
            </div>
            <Meter t={s ?? { raw: 0, proven: 0 }} />
          </div>
          {dots.length > 0 && (
            <div className="am-dots" aria-label={`Last ${dots.length} drafts`}>
              {dots.map((d) => (
                <i key={d.id} className={DOT[d.outcome]} title={`${day(d.draftedAt)}: ${d.outcome}`} />
              ))}
            </div>
          )}
          <div className="foot">
            {s ? `Since ${day(s.since!)} · ${s.drafts} drafts · ${s.waiting} not graded yet` : "Nothing drafted since the grader started"}
          </div>
        </>
      )}
    </Link>
  );
}

function Chart({ weeks }: { weeks: WeekStats[] }) {
  const ws = weeks.slice(-8);
  if (!ws.length) return <div className="note">No graded weeks yet.</div>;
  const W = 420, H = 150, pl = 28, pb = 22, pt = 20;
  const step = (W - pl - 10) / ws.length;
  const bw = Math.min(46, step - 14);
  const max = Math.max(...ws.map((w) => w.right + w.changed + w.out));
  const top = Math.max(4, Math.ceil(max / 2) * 2);
  const y = (v: number) => H - pb - (v / top) * (H - pb - pt);
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, minWidth: 300 }} role="img" aria-label="Graded outcomes by week">
        {[0, top / 2, top].map((t) => (
          <g key={t}>
            <line x1={pl} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#f4f4f5" strokeWidth={1.5} />
            <text x={pl - 6} y={y(t) + 3} textAnchor="end" className="am-svg">{t}</text>
          </g>
        ))}
        {ws.map((w, i) => {
          const x = pl + i * step + (step - bw) / 2;
          let base = 0;
          const tot = w.right + w.changed + w.out;
          return (
            <g key={w.week}>
              {([[w.right, "#15803d"], [w.changed, "#e59a1a"], [w.out, "#c62828"]] as const).map(([v, c], j) => {
                if (!v) return null;
                const r = <rect key={j} x={x} y={y(base + v)} width={bw} height={y(base) - y(base + v)} fill={c} rx={2} />;
                base += v;
                return r;
              })}
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="am-svg">{day(`${w.week}T12:00:00Z`)}</text>
              <text x={x + bw / 2} y={y(tot) - 4} textAnchor="middle" className="am-svg strong">{tot ? `${Math.round((w.right / tot) * 100)}%` : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Gates({ v }: { v: AutomationView }) {
  const s = v.stats;
  const none = !s?.n;
  const g = (ok: boolean) => (none ? "w" : ok ? "y" : "n");
  const sym = { y: "✓", n: "✕", w: "·" } as const;
  const kinds = v.kinds.filter((k) => k.path !== "human");
  const rows: Array<[keyof typeof sym, string, string, string]> = [
    [g((s?.proven ?? 0) >= BAR.proven), `Proven ${BAR.proven}%+ right`, none ? "n/a" : `${s!.proven}%`, "With 95% confidence, from every graded draft"],
    [g((s?.raw ?? 0) >= BAR.raw), `Raw ${BAR.raw}%+ right`, none ? "n/a" : `${s!.raw}%`, "Sent as drafted or with a light edit; a wrong fact, price, date or tone is a miss"],
    [g((s?.hurt ?? 0) === 0), `Nothing that would have hurt in the last ${BAR.hurtWindow}`, none ? "n/a" : String(s!.hurt), "Only your own grade can say this"],
    [none ? "w" : v.ready ? "y" : "n", "Kinds of cases that qualify on their own", `${v.ready} of ${kinds.length}`, `Each kind is judged and turned on separately, below.${v.kinds.length - kinds.length ? ` ${v.kinds.length - kinds.length} more always draft for you.` : ""}`],
  ];
  const near = (path: string) => kinds.filter((k) => k.path === path && k.stats?.n && k.stats.toBar !== null).sort((a, b) => a.stats!.toBar! - b.stats!.toBar!)[0];
  const best = near("fast") ?? near("learn");
  return (
    <div className="card">
      <h4 className="am-h4">The bar, all kinds together</h4>
      <div>
        {rows.map((r) => (
          <div key={r[1]} className="am-gate">
            <span className={`ic ${r[0]}`}>{sym[r[0]]}</span>
            <span>
              {r[1]}
              <small>{r[3]}</small>
            </span>
            <span className="v num">{r[2]}</span>
          </div>
        ))}
      </div>
      <div className="note">
        <b>Closest.</b>{" "}
        {best
          ? best.stats!.toBar === 0
            ? `${best.name} already clears the bar.`
            : `${best.name}: ${best.stats!.toBar} more right in a row would clear the bar (now ${best.stats!.k} of ${best.stats!.n}).`
          : "No kind that can auto-send has grades yet."}
      </div>
    </div>
  );
}

function KindTable({ v }: { v: AutomationView }) {
  const row = (k: KindRow) => {
    const s = k.stats;
    const human = k.path === "human";
    const st: [string, string] = human
      ? ["nd", "Always drafts"]
      : s?.qualifies
        ? ["on", "Ready"]
        : !s?.n
          ? ["nd", s?.drafts ? "Not graded yet" : "No drafts yet"]
          : s.hurt
            ? ["off", `${s.hurt} would have hurt`]
            : ["risk", "Learning"];
    return (
      <tr key={k.kind}>
        <td className="wrapc">
          <b style={{ color: "var(--ink)" }}>{k.name}</b>
          {k.sub && <small>{k.sub}</small>}
        </td>
        <td className="r num">{k.share || "n/a"}</td>
        <td className="r num">{s?.n ? `${s.k} of ${s.n}` : "0"}</td>
        <td style={{ minWidth: 140 }}>
          <Meter t={s ?? { raw: 0, proven: 0 }} small />
          <small className="num am-muted" style={{ fontWeight: 700 }}>
            {s?.n ? `raw ${s.raw}% · proven ${s.proven}%` : "not graded yet"}
          </small>
          {!human && s?.n && !s.qualifies && s.toBar !== null ? <small className="am-muted">{s.toBar} more right in a row to clear the bar</small> : null}
        </td>
        <td className="r num">{s?.hurt ?? 0}</td>
        <td>
          <span className={`st ${st[0]}`}>{st[1]}</span>
        </td>
        <td>{human ? null : <button className="am-toggle" disabled aria-label={`Auto-send ${k.name}: off`} title={s?.qualifies ? "Ready: your call (the switch is built at graduation)" : "Locked until this kind clears the bar"} />}</td>
      </tr>
    );
  };
  return (
    <div className="card">
      <div className="sec-h">
        <h4 className="am-h4">By kind of case</h4>
        <span className="hint">Each kind clears the bar and turns on by itself; the rest keep drafting for you</span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th className="r">How common</th>
              <th className="r">Right</th>
              <th>Proven vs {BAR.proven}% bar</th>
              <th className="r">Hurt</th>
              <th>Status</th>
              <th>Auto-send</th>
            </tr>
          </thead>
          <tbody>
            {(["fast", "learn", "human"] as const).map((p) => {
              const rs = v.kinds.filter((k) => k.path === p);
              if (!rs.length) return null;
              return [
                <tr key={p} className="am-grp">
                  <td colSpan={7}>
                    <b>{PATHS[p][0]}</b>
                    <span>{PATHS[p][1]}</span>
                  </td>
                </tr>,
                ...rs.map(row),
              ];
            })}
          </tbody>
        </table>
      </div>
      {v.meta.basis && (
        <div className="note">
          <b>How it&apos;s graded.</b> {v.meta.basis}
        </div>
      )}
      {v.meta.flags && (
        <div className="note">
          <b>Always drafts for you.</b> {v.meta.flags}
        </div>
      )}
    </div>
  );
}

/** "owner CHANGED Crack Repair: ×1 @ $875 ← ×2 @ $1175" → "Crack Repair: 2 × $1,175 → 1 × $875". */
function plainChange(c: string): string {
  const qp = (x: string) => x.replace(/×(\d+(?:\.\d+)?) @ \$(-?[\d.]+)/g, (_, q: string, p: string) => `${q} × ${money(Number(p))}`);
  let m = /^owner CHANGED (.+?): (.+) ← (.+)$/.exec(c);
  if (m) return `${m[1]}: ${qp(m[3])} → ${qp(m[2])}`;
  m = /^owner ADDED (.+)$/.exec(c);
  if (m) return `Added ${qp(m[1])}`;
  m = /^owner REMOVED (.+?)(?: ×.*)?$/.exec(c);
  if (m) return `Removed ${m[1]}`;
  return c;
}

function rowsOf(v: AutomationView, s: AutomationStats): DraftRowData[] {
  const kindName = (k: string) => v.meta.kinds[k]?.name ?? k;
  return s.recent.slice(0, 40).map((d) => ({
    id: d.id,
    isQuote: d.automation === "quote",
    date: day(d.draftedAt),
    who: d.automation === "quote" ? `${d.doc ? `#${d.doc} ` : ""}${d.customer ?? ""}` : [d.customer, d.doc && `#${d.doc}`, phone(d.phone)].filter(Boolean).join(" · "),
    kind: kindName(d.kind),
    outcome: d.outcome,
    autoGrade: d.grade === "waiting" ? "not graded yet" : d.grade,
    hand: d.hand?.grade ?? null,
    drafted: money(d.total),
    sent: d.grade === "waiting" || d.grade === "unused" || d.grade === "thrown-out" ? "n/a" : money(d.sentTotal),
    match: d.similarity === undefined ? "" : `${Math.round(d.similarity * 100)}%`,
    changes: (d.changes ?? []).map(plainChange),
    note: d.note ?? (d.grade === "as-is" ? "No changes" : ""),
    draftText: d.draft ?? "",
    sentText: d.sent ?? "",
    lines: (d.lines ?? []).map((l) => `${l.item} × ${l.qty} @ ${money(l.unitPrice)}`),
  }));
}

function Detail({ v }: { v: AutomationView }) {
  const s = v.stats;
  const [cls, label] = status(v);
  return (
    <section id="detail" className="am-stack">
      <div className="card am-big">
        <div className="am-dhead">
          <div className="t">
            <span className="micro" style={{ color: "var(--accent)" }}>Drill-in</span>
            <h2>{v.meta.name}</h2>
            <span style={{ color: "var(--ink-2)" }}>{v.meta.what}</span>
          </div>
          <span className={`st ${cls}`}>{label}</span>
        </div>
        {v.meta.notMeasured ? (
          <div className="note">{v.meta.notMeasured}</div>
        ) : (
          <div className="cols">
            <div className="am-stack" style={{ gap: 8 }}>
              <h4 className="am-h4">Outcomes by week · % right on top</h4>
              <Chart weeks={s?.weeks ?? []} />
            </div>
            <Gates v={v} />
          </div>
        )}
      </div>
      {!v.meta.notMeasured && <KindTable v={v} />}
      {!v.meta.notMeasured && (
        <div className="card">
          <h4 className="am-h4">What it learned from your edits</h4>
          <div className="note">The weekly review of your changes (proposed rule changes, with their evidence) is the next piece to build. Until then, every changed draft is below.</div>
        </div>
      )}
      {s && s.recent.length > 0 && (
        <div className="card">
          <div className="sec-h">
            <h4 className="am-h4">Recent drafts: what it wrote vs. what you sent</h4>
            <span className="hint">Open a row to compare and grade it yourself</span>
          </div>
          <DraftRows rows={rowsOf(v, s)} />
        </div>
      )}
    </section>
  );
}

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const header = (
    <PageHeader
      eyebrow="Area · System"
      title="Automations"
      sub="Every automation that drafts for you, how often you use what it drafts, and how close each kind of case is to the bar you set for turning it on."
      right={<SystemTabs on="automations" />}
    />
  );
  let data: AutomationsData;
  try {
    data = await readAutomations();
  } catch (err) {
    return (
      <>
        {header}
        <div className="callout" style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)" }}>
          <b>Couldn&apos;t read Redis.</b> {(err as Error).message}
        </div>
      </>
    );
  }
  const { a } = await searchParams;
  const sel = data.views.find((v) => v.meta.id === a) ?? data.views[0];
  const measured = data.views.filter((v) => !v.meta.notMeasured);
  return (
    <>
      {header}
      <div className="glance">
        <Glance k="Automations" v={data.views.length} />
        <Glance k="Live" v={data.views.filter((v) => v.meta.live).length} />
        <Glance k="Kinds ready to turn on" v={measured.reduce((n, v) => n + v.ready, 0)} />
        <Glance k="Graded this week" v={data.gradedThisWeek} />
        <Glance k="Your grades" v={`${data.handGraded} of ${CALIBRATE}`} />
      </div>
      <div className="callout">
        <b>The bar (Matt, 11/06):</b> proven at least {BAR.proven}% right with 95% confidence, raw {BAR.raw}%+, nothing that would have hurt in the last {BAR.hurtWindow}, and each kind of case qualifies on its own. No time box: volume decides.
      </div>
      {data.handGraded < CALIBRATE && (
        <div className="callout">
          <b>Check the grader.</b> Grades are automatic until they&apos;ve been checked against yours. Open any draft below and grade it; about {CALIBRATE} across the automations sets the cutoffs.
          {data.lastRun?.at ? ` Last grader run ${day(data.lastRun.at)}, ${data.lastRun.mode}.` : " The grader hasn't run yet."}
        </div>
      )}
      <section className="am-stack" style={{ gap: 10 }}>
        <div className="sec-h">
          <h2>All automations</h2>
          <div className="am-legend">
            <span><i className="am-dots"><i className="ok" /></i>Right</span>
            <span><i className="am-dots"><i className="chg" /></i>Changed</span>
            <span><i className="am-dots"><i className="del" /></i>Thrown out</span>
            <span><i className="am-dots"><i className="nd" /></i>Not used</span>
            <span><i className="am-dots"><i className="wait" /></i>Not graded yet</span>
            <span>Meter: dark = proven, light = raw, line = the {BAR.proven}% bar</span>
          </div>
        </div>
        <div className="am-autos">
          {data.views.map((v) => (
            <Card key={v.meta.id} v={v} sel={v === sel} />
          ))}
        </div>
      </section>
      <Detail v={sel} />
    </>
  );
}
