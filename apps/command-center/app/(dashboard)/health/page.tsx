import { deriveMiddlewareStatus } from "@/lib/middleware-status";
import { CI_CARD, readSystemHealth, type Level, type SystemHealth } from "@/lib/system-health";
import {
  CI_RED_ONGOING_HOURS,
  CI_RED_ONGOING_RUNS,
  JOBS_NOT_INVOICED_ONGOING,
  JOBS_NOT_INVOICED_WINDOW_DAYS,
  jobsNotInvoicedOngoing,
  reasonShort,
} from "@/lib/system-rules";
import { Freshness } from "../components/freshness";
import { NeedsAttention } from "../components/items";
import { PageHeader, Tile } from "../components/layout-parts";
import { SystemTabs } from "./system-tabs";

export const dynamic = "force-dynamic";

const ST: Record<Level, "on" | "risk" | "off" | "nd"> = { green: "on", yellow: "risk", red: "off", gray: "nd" };
const ST_LABEL: Record<Level, string> = { green: "OK", yellow: "Check", red: "Check", gray: "No data" };

function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function eastern(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Status({ level, children }: { level: Level; children?: React.ReactNode }) {
  return <span className={`st ${ST[level]}`}>{children ?? ST_LABEL[level]}</span>;
}

/** The mockup's System table: one row per automation group, status, plain detail. */
function overview(h: SystemHealth, now: number): Array<[string, Level, string]> {
  const mw = deriveMiddlewareStatus(h.middleware);
  const sig = (name: string) => h.signals.find((s) => s.name === name && s.kind === "heartbeat");
  const crons = h.signals.filter((s) => s.kind === "cron" && s.level !== "gray");
  const late = crons.filter((s) => s.level === "red");
  const canary = sig("gemini-canary");
  const skipsToday = h.conditions.reduce((a, c) => a + c.today, 0);
  const ci = h.ci.verdict;
  const ciSnap = h.ci.snap?.data;
  return [
    [
      "Watchdog (texts you on P1)",
      h.watchdog.length ? "red" : sig("watchdog")?.level ?? "gray",
      h.watchdog.length
        ? `${h.watchdog.length} open: ${h.watchdog.map((w) => w.id).join(", ")}`
        : `No open alerts · last check ${timeAgo(sig("watchdog")?.at, now)}`,
    ],
    ["Middleware (Quo, QBO, Pipedrive webhooks)", mw.level, mw.label],
    [
      "Crons (middleware, worker, agent)",
      late.length ? "red" : crons.length ? "green" : "gray",
      late.length ? `${late.length} late: ${late.map((s) => s.label).join(", ")}` : `${crons.length} of ${crons.length} on schedule`,
    ],
    ["Quote drafter", sig("quote-drafter")?.level ?? "gray", `Last run ${timeAgo(sig("quote-drafter")?.at, now)}`],
    [
      "Gemini canary",
      canary?.level ?? "gray",
      canary?.at ? `Passed ${eastern(canary.at)}` : "Has not passed yet (hourly, worker)",
    ],
    [
      "CI on main",
      !ciSnap?.configured ? "gray" : ci.state === "green" ? "green" : ci.state === "red" ? (ci.ongoing ? "red" : "yellow") : "gray",
      !ciSnap
        ? "Not loaded yet"
        : !ciSnap.configured
          ? `CI status unavailable (set ${ciSnap.envVar})`
          : ci.state === "red"
            ? `Red for ${ci.redStreak} run${ci.redStreak === 1 ? "" : "s"}${ci.latest?.failedStep ? `, failing at "${ci.latest.failedStep}"` : ""}`
            : ci.state === "green"
              ? `Green · #${ci.latest?.number} ${ci.latest?.title ?? ""}`
              : "Running",
    ],
    [
      "Jobs not invoiced",
      h.jobs.length === 0 ? "green" : jobsNotInvoicedOngoing(h.jobs) ? "red" : "yellow",
      h.jobs.length ? `${h.jobs.length} in the last ${JOBS_NOT_INVOICED_WINDOW_DAYS} days` : `None in the last ${JOBS_NOT_INVOICED_WINDOW_DAYS} days`,
    ],
    ["Silent skips", skipsToday ? "yellow" : "green", skipsToday ? `${skipsToday} today (below)` : "None today"],
  ];
}

export default async function HealthPage() {
  const header = <PageHeader eyebrow="Area" title="System" sub="Only shows up on Today when something breaks" right={<SystemTabs on="health" />} />;
  let h: SystemHealth;
  try {
    h = await readSystemHealth();
  } catch (err) {
    return (
      <>
        {header}
        <NeedsAttention areas={["system"]} />
        <div className="callout" style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)" }}>
          <b>Couldn&apos;t read Redis.</b> {(err as Error).message}
        </div>
      </>
    );
  }
  const now = Date.parse(h.now);
  const m = h.middleware.metrics;
  const ciSnap = h.ci.snap;

  return (
    <>
      {header}
      <NeedsAttention areas={["system"]} />

      <div className="card">
        <div className="tbl-wrap">
          <table>
            <tbody>
              {overview(h, now).map(([name, level, detail]) => (
                <tr key={name}>
                  <td style={{ fontWeight: 600 }}>{name}</td>
                  <td>
                    <Status level={level} />
                  </td>
                  <td style={{ whiteSpace: "normal", color: "var(--muted)" }}>{detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {h.watchdog.length > 0 && (
        <div className="card">
          <h3>Open watchdog alerts · {h.watchdog.length}</h3>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Down since</th>
                  <th>Texted</th>
                </tr>
              </thead>
              <tbody>
                {h.watchdog.map((w) => (
                  <tr key={w.id}>
                    <td style={{ fontWeight: 600 }}>{w.id}</td>
                    <td>{eastern(w.since)}</td>
                    <td>{w.alertedAt ? eastern(w.alertedAt) : `Not yet (${w.ticks} tick${w.ticks === 1 ? "" : "s"})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="cols">
        <div className="card" id="jobs-not-invoiced">
          <h3>Jobs not invoiced · {h.jobs.length}</h3>
          {h.jobs.length ? (
            <div className="tbl-wrap">
              <table>
                <tbody>
                  {h.jobs.map((j) => (
                    <tr key={j.id}>
                      <td style={{ whiteSpace: "normal", fontWeight: 600 }}>{j.label}</td>
                      <td style={{ whiteSpace: "normal", color: "var(--muted)" }}>{reasonShort(j.reason)}</td>
                      <td className="r num">{j.day.slice(5)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">invoice-create skipped no jobs in the last {JOBS_NOT_INVOICED_WINDOW_DAYS} days.</div>
          )}
          <div className="note">
            Jobs the 7am invoice-create run skipped. No text: this goes to Today only when {JOBS_NOT_INVOICED_ONGOING}+ jobs are
            skipped within {JOBS_NOT_INVOICED_WINDOW_DAYS} days.
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
            <h3>CI on main</h3>
            <Freshness name={CI_CARD} fetchedAt={ciSnap?.fetchedAt} label="GitHub" />
          </div>
          {!ciSnap ? (
            <div className="empty">Not loaded yet. The 15-minute refresh fills it, or use ↻.</div>
          ) : !ciSnap.data.configured ? (
            <div className="callout">
              CI status unavailable (set <code>{ciSnap.data.envVar}</code> on the command center project).
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <tbody>
                  {ciSnap.data.runs.slice(0, 6).map((r) => {
                    const level: Level =
                      r.status !== "completed" ? "gray" : r.conclusion === "success" ? "green" : r.conclusion === "failure" ? "red" : "gray";
                    return (
                      <tr key={r.id}>
                        <td>
                          <Status level={level}>{r.status !== "completed" ? "Running" : (r.conclusion ?? "?")}</Status>
                        </td>
                        <td style={{ whiteSpace: "normal" }}>
                          <a href={r.url}>#{r.number}</a> {r.title}
                          {r.failedStep && <span style={{ color: "var(--red)" }}> · failed at {r.failedStep}</span>}
                        </td>
                        <td className="r" style={{ color: "var(--muted)" }}>
                          {timeAgo(r.createdAt, now)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="note">
            No email. Goes to Today only when main is red for {CI_RED_ONGOING_RUNS}+ runs in a row or {CI_RED_ONGOING_HOURS}h.
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Silent skips</h3>
        {h.conditions.length ? (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>What was skipped</th>
                  <th className="r">Today</th>
                  <th className="r">7 days</th>
                </tr>
              </thead>
              <tbody>
                {h.conditions.map((c) => (
                  <tr key={c.name}>
                    <td style={{ whiteSpace: "normal" }}>
                      {c.label} <span className="micro" style={{ color: "var(--muted)" }}>{c.name}</span>
                    </td>
                    <td className="r num">{c.today}</td>
                    <td className="r num">{c.week}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">Nothing skipped in the last 7 days.</div>
        )}
        <div className="note">
          Counted, never texted, except Gemini failing 3+ times in an hour, which the watchdog texts.
        </div>
      </div>

      <div className="card">
        <h3>Heartbeats and crons</h3>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Automation</th>
                <th>Where</th>
                <th>Last run</th>
                <th className="r">Today</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {h.signals.map((s) => (
                <tr key={`${s.kind}:${s.name}`}>
                  <td style={{ whiteSpace: "normal" }}>
                    <b>{s.label}</b>
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>{s.what}</div>
                  </td>
                  <td>{s.app}</td>
                  <td title={s.at ?? undefined}>{timeAgo(s.at, now)}</td>
                  <td className="r num">
                    {s.result ? `${s.result.sent} ok · ${s.result.skipped} skip · ${s.result.errors} err` : ""}
                  </td>
                  <td>
                    <Status level={s.level}>{s.level === "gray" ? "Off / never" : s.level === "red" ? (s.at ? "Late" : "Never ran") : "OK"}</Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="tiles">
        {(
          [
            ["Quo webhooks", m?.webhooks.quo],
            ["Pipedrive webhooks", m?.webhooks.pipedrive],
            ["Google Ads webhooks", m?.webhooks.googleAds],
          ] as const
        ).map(([name, wh]) => (
          <Tile key={name} k={`${name}, 24h`} v={wh?.processed24h ?? 0} s={`Last: ${timeAgo(wh?.lastProcessed ?? null, now)}`} />
        ))}
        <Tile k="Health errors kept" v={h.errorCount} s="health:errors, newest 100" />
      </div>

      <div className="card">
        <h3>Recent errors</h3>
        {h.errors.length ? (
          <div className="list">
            {h.errors.map((err, i) => (
              <div key={`${err.timestamp}-${i}`} className="note">
                <span className="micro">{err.source}</span> · {timeAgo(err.timestamp, now)}
                <div style={{ color: "var(--ink)", fontWeight: 600, marginTop: 2 }}>{err.message}</div>
                {err.details && (
                  <div>
                    {Object.entries(err.details)
                      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                      .join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No recent errors.</div>
        )}
      </div>
    </>
  );
}
