import { fetchMiddlewareHealth } from "@/lib/middleware-health";
import { deriveMiddlewareStatus } from "@/lib/middleware-status";
import { NeedsAttention } from "../components/items";
import { PageHeader, Tile } from "../components/layout-parts";

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

const ST = { green: "on", yellow: "risk", red: "off", gray: "nd" } as const;

export const revalidate = 30;

export default async function HealthPage() {
  const data = await fetchMiddlewareHealth();
  const header = <PageHeader eyebrow="Area" title="System" sub="Only shows up on Today when something breaks" />;

  if (data.status === "unreachable") {
    return (
      <>
        {header}
        <NeedsAttention areas={["system"]} />
        <div className="callout" style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)" }}>
          <b>Middleware unreachable.</b> {data.error ?? "Check MIDDLEWARE_HEALTH_URL env var."}
        </div>
      </>
    );
  }

  const m = data.metrics;
  const { level, label } = deriveMiddlewareStatus(data);

  return (
    <>
      {header}
      <NeedsAttention areas={["system"]} />
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600 }}>Middleware (Quo, QBO, Pipedrive webhooks)</td>
                <td>
                  <span className={`st ${ST[level]}`}>{level === "green" ? "OK" : "Check"}</span>
                </td>
                <td style={{ whiteSpace: "normal", color: "var(--muted)" }}>
                  {label} · version {data.version} · checked {new Date(data.timestamp).toLocaleTimeString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="tiles">
        {(
          [
            ["Pipedrive webhooks", m?.webhooks.pipedrive],
            ["Quo webhooks", m?.webhooks.quo],
            ["Google Ads webhooks", m?.webhooks.googleAds],
          ] as const
        ).map(([name, wh]) => (
          <Tile key={name} k={`${name}, 24h`} v={wh?.processed24h ?? 0} s={`Last: ${timeAgo(wh?.lastProcessed ?? null)}`} />
        ))}
      </div>
      <div className="cols">
        <div className="card">
          <h3>Sync mappings</h3>
          <div className="tbl-wrap">
            <table>
              <tbody>
                <tr>
                  <td>Pipedrive ↔ Quo</td>
                  <td className="r num">{m?.sync.pdToQuo ?? 0}</td>
                </tr>
                <tr>
                  <td>Pipedrive ↔ QuickBooks</td>
                  <td className="r num">{m?.sync.pdToQb ?? 0}</td>
                </tr>
                <tr>
                  <td>Phone → Pipedrive</td>
                  <td className="r num">{m?.sync.phoneToPd ?? 0}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>Recent errors</h3>
          {m?.errors.length ? (
            <div className="list">
              {m.errors.map((err, i) => (
                <div key={`${err.timestamp}-${i}`} className="note">
                  <span className="micro">{err.source}</span> · {timeAgo(err.timestamp)}
                  <div style={{ color: "var(--ink)", fontWeight: 600, marginTop: 2 }}>{err.message}</div>
                  {err.details && (
                    <div>
                      {typeof err.details === "string"
                        ? err.details
                        : Object.entries(err.details)
                            .map(([k, v]) => `${k}: ${v}`)
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
      </div>
    </>
  );
}
