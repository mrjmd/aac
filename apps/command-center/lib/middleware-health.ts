/**
 * Types and fetcher for middleware health data.
 *
 * The middleware exposes GET /api/health which returns webhook counts,
 * sync mapping counts, heartbeat, and recent errors — all pre-aggregated.
 * We proxy through our own API route to avoid CORS and keep the middleware
 * URL server-side only.
 */

export interface WebhookMetrics {
  processed24h: number;
  lastProcessed: string | null;
}

export interface MiddlewareHealth {
  status: "healthy" | "error" | "unreachable";
  version?: string;
  timestamp: string;
  metrics?: {
    webhooks: {
      pipedrive: WebhookMetrics;
      quo: WebhookMetrics;
      googleAds: WebhookMetrics;
    };
    sync: {
      pdToQuo: number;
      pdToQb: number;
      phoneToPd: number;
    };
    errors: Array<{
      timestamp: string;
      source: string;
      message: string;
      details?: Record<string, string> | string;
    }>;
  };
  error?: string;
}

/**
 * Fetch middleware health from the middleware's /api/health endpoint.
 * Called server-side only (from API routes or server components).
 */
export async function fetchMiddlewareHealth(): Promise<MiddlewareHealth> {
  const url = process.env.MIDDLEWARE_HEALTH_URL;
  if (!url) {
    return {
      status: "unreachable",
      timestamp: new Date().toISOString(),
      error: "MIDDLEWARE_HEALTH_URL not configured",
    };
  }

  try {
    const res = await fetch(url, {
      next: { revalidate: 30 },
    });

    if (!res.ok) {
      return {
        status: "error",
        timestamp: new Date().toISOString(),
        error: `HTTP ${res.status}`,
      };
    }

    return (await res.json()) as MiddlewareHealth;
  } catch (e) {
    return {
      status: "unreachable",
      timestamp: new Date().toISOString(),
      error: (e as Error).message,
    };
  }
}
