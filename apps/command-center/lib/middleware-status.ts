import type { StatusLevel } from "@aac/ui";
import type { MiddlewareHealth } from "./middleware-health";

/**
 * Single source of truth for middleware status derivation.
 * Used by both the dashboard card and the detail page.
 *
 * Logic:
 *  - Green: events flowing, no errors in the last hour
 *  - Yellow: 1-4 errors in last hour, or no events in 30 min
 *  - Red: 5+ errors this hour, or no events in 1h+, or middleware down
 *  - Gray: can't reach middleware
 */
export function deriveMiddlewareStatus(data: MiddlewareHealth | null): {
  level: StatusLevel;
  label: string;
} {
  if (!data || data.status === "unreachable")
    return { level: "gray", label: "Unreachable" };
  if (data.status === "error") return { level: "red", label: "Down" };
  if (!data.metrics) return { level: "gray", label: "No data" };

  const now = Date.now();
  const oneHourAgo = now - 3_600_000;

  // Check if webhooks are flowing
  const sources = data.metrics.webhooks;
  const lastTimes = [
    sources.pipedrive.lastProcessed,
    sources.quo.lastProcessed,
  ]
    .filter(Boolean)
    .map((t) => new Date(t!).getTime());
  const mostRecent = lastTimes.length ? Math.max(...lastTimes) : 0;
  const minutesSinceLastEvent = mostRecent
    ? Math.round((now - mostRecent) / 60_000)
    : Infinity;

  // Count errors in the last hour only
  const recentErrors = data.metrics.errors.filter(
    (e) => new Date(e.timestamp).getTime() > oneHourAgo,
  ).length;

  if (minutesSinceLastEvent > 60)
    return { level: "red", label: "No events in 1h+" };
  if (minutesSinceLastEvent > 30)
    return { level: "yellow", label: `Last event ${minutesSinceLastEvent}m ago` };

  if (recentErrors >= 5)
    return { level: "red", label: `${recentErrors} errors this hour` };
  if (recentErrors > 0)
    return { level: "yellow", label: `${recentErrors} error${recentErrors > 1 ? "s" : ""} this hour` };

  return { level: "green", label: "All systems go" };
}
