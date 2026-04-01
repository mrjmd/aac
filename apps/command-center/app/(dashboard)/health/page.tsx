import { fetchMiddlewareHealth } from "@/lib/middleware-health";
import { deriveMiddlewareStatus } from "@/lib/middleware-status";
import { StatusIndicator } from "@aac/ui";

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export const revalidate = 30;

export default async function HealthPage() {
  const data = await fetchMiddlewareHealth();

  if (data.status === "unreachable") {
    return (
      <div>
        <h2 className="font-display mb-6 text-2xl font-bold">System Health</h2>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          <StatusIndicator status="gray" className="mb-3 justify-center" />
          <p className="font-medium text-aac-dark">Middleware unreachable</p>
          <p className="mt-1 text-sm text-zinc-400">
            {data.error ?? "Check MIDDLEWARE_HEALTH_URL env var."}
          </p>
        </div>
      </div>
    );
  }

  const m = data.metrics;
  const { level, label } = deriveMiddlewareStatus(data);

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h2 className="font-display text-2xl font-bold">System Health</h2>
        <StatusIndicator status={level} label={label} />
      </div>

      {/* Webhook counts */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {(
          [
            ["Pipedrive", m?.webhooks.pipedrive],
            ["Quo / OpenPhone", m?.webhooks.quo],
            ["Google Ads", m?.webhooks.googleAds],
          ] as const
        ).map(([name, wh]) => (
          <div
            key={name}
            className="rounded-xl border border-zinc-200 bg-white p-4"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
              {name}
            </p>
            <p className="mt-1 text-2xl font-bold text-aac-dark">
              {wh?.processed24h ?? 0}
            </p>
            <p className="text-xs text-zinc-400">
              Last: {timeAgo(wh?.lastProcessed ?? null)}
            </p>
          </div>
        ))}
      </div>

      {/* Sync mappings */}
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-display mb-3 text-sm font-bold uppercase tracking-wider text-aac-dark">
          Sync Mappings
        </h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-zinc-400">Pipedrive ↔ Quo</p>
            <p className="text-lg font-bold text-aac-dark">
              {m?.sync.pdToQuo ?? 0}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-400">Pipedrive ↔ QuickBooks</p>
            <p className="text-lg font-bold text-aac-dark">
              {m?.sync.pdToQb ?? 0}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-400">Phone → Pipedrive</p>
            <p className="text-lg font-bold text-aac-dark">
              {m?.sync.phoneToPd ?? 0}
            </p>
          </div>
        </div>
      </div>

      {/* Recent errors */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-display mb-3 text-sm font-bold uppercase tracking-wider text-aac-dark">
          Recent Errors
        </h3>
        {m?.errors.length ? (
          <div className="space-y-2">
            {m.errors.map((err, i) => (
              <div
                key={`${err.timestamp}-${i}`}
                className="rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-3"
              >
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="font-medium uppercase text-zinc-500">
                    {err.source}
                  </span>
                  <span>{timeAgo(err.timestamp)}</span>
                </div>
                <p className="mt-1 text-sm text-aac-dark">{err.message}</p>
                {err.details && (
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {typeof err.details === "string"
                      ? err.details
                      : Object.entries(err.details)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No recent errors.</p>
        )}
      </div>

      {/* Meta */}
      <p className="mt-4 text-xs text-zinc-300">
        Middleware {data.version} · Last checked{" "}
        {new Date(data.timestamp).toLocaleTimeString()}
      </p>
    </div>
  );
}
