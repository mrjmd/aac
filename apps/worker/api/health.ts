/**
 * Health probe for an outside uptime pinger (route: /api/health).
 * Unauthenticated and detail-free: 200 {status: 'ok'} only while Redis
 * answers and the watchdog ran in the last 15 minutes, else 503
 * {status: 'down'}. The pinger is the one alert path that shares no fate
 * with Vercel crons, Upstash or Quo.
 */
import { watchdogFresh } from '../lib/health.js';

export async function GET(): Promise<Response> {
  const ok = await watchdogFresh();
  return new Response(JSON.stringify({ status: ok ? 'ok' : 'down' }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
