/**
 * Wiring for the watchdog tick: Redis, Quo (read the business line's newest
 * activity; text Matt from the agent line), and the middleware health URL.
 */
import type { WatchdogDeps } from '@aac/watchdog';
import { getWorkerDeps } from './deps.js';

const DEFAULT_HEALTH_URL = 'https://aac-middleware-monorepo.vercel.app/api/health';
const DEFAULT_AGENT_LINE = '+16177660151';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getWatchdogDeps(): WatchdogDeps {
  const { deps, redis } = getWorkerDeps();
  const quo = deps.quo;
  const recipient = requireEnv('MATT_PERSONAL_PHONE_NUMBER');
  const sender = process.env.QUO_AGENT_PHONE_NUMBER || DEFAULT_AGENT_LINE;
  const healthUrl = process.env.MIDDLEWARE_HEALTH_URL || DEFAULT_HEALTH_URL;
  return {
    redis,
    async quoNewestActivity(since) {
      // listConversations order is unreliable and Quo ignores unknown params,
      // so bound server-side AND filter client-side.
      const page = await quo.listConversations({ maxResults: 50, updatedAfter: since });
      const times = page.data
        .map((c) => c.lastActivityAt)
        .filter((t): t is string => !!t && Date.parse(t) >= since.getTime())
        .sort();
      return times.at(-1) ?? null;
    },
    async middlewareHealth() {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return body.status === 'healthy' ? { ok: true, detail: 'healthy' } : { ok: false, detail: `status ${body.status ?? 'unknown'}` };
    },
    async sms(text) {
      await quo.sendMessage(recipient, text, sender);
    },
  };
}
