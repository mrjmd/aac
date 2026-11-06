/**
 * The middleware health card's data. Read straight from Redis
 * (readMiddlewareHealth in lib/system-health.ts): the middleware's public
 * /api/health no longer returns error details, and the command center is
 * behind the session so it can show them.
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
    errors: Array<{
      timestamp: string;
      source: string;
      message: string;
      details?: Record<string, string> | string;
    }>;
  };
  error?: string;
}
