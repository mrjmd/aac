/**
 * Wiring for the watchdog tick: Redis, Quo (read the business line's newest
 * activity; text Matt from the agent line), and the middleware health URL.
 *
 * When the Quo text throws (key revoked, Quo down) the alert goes by email
 * instead: Gmail send through the worker's Google token, to
 * WATCHDOG_ALERT_EMAIL or, unset, the token's own mailbox. That needs a
 * send-capable scope (gmail.send, gmail.compose or gmail.modify) on
 * GOOGLE_REFRESH_TOKEN; without it the fallback logs why and the original
 * Quo error stands (the tick fails, its heartbeat goes stale, and the
 * outside pinger on /api/health catches that).
 */
import type { WatchdogDeps } from '@aac/watchdog';
import { GmailClient, isInsufficientScopeError } from '@aac/api-clients/gmail';
import { createLogger } from '@aac/shared-utils/logger';
import { getWorkerDeps } from './deps.js';

const log = createLogger('worker-watchdog-deps');

/** Subject of the fallback email (ASCII: the header isn't RFC 2047 encoded). */
export const FALLBACK_SUBJECT = 'AAC watchdog alert (Quo text failed)';

let gmail: GmailClient | null | undefined;

function getGmail(): GmailClient | null {
  if (gmail !== undefined) return gmail;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  gmail =
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN
      ? new GmailClient({
          oauth: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN },
          retry: { maxAttempts: 2, baseDelayMs: 1000 },
        })
      : null;
  return gmail;
}

/** Email the alert to Matt. True when it went out; never throws. */
export async function emailFallback(text: string, quoError: Error): Promise<boolean> {
  const client = getGmail();
  if (!client) {
    log.error('watchdog email fallback unavailable: no Google OAuth env on the worker', undefined, { alert: text });
    return false;
  }
  try {
    const to = process.env.WATCHDOG_ALERT_EMAIL || (await client.getProfileEmail());
    await client.sendMessage({
      to: [to],
      subject: FALLBACK_SUBJECT,
      body: `${text}\n\n(Sent by email because the Quo text failed: ${quoError.message.slice(0, 300)})`,
    });
    return true;
  } catch (err) {
    const why = isInsufficientScopeError(err)
      ? 'GOOGLE_REFRESH_TOKEN has no send scope (gmail.send / compose / modify); re-mint it'
      : (err as Error).message;
    log.error(`watchdog email fallback failed: ${why}`, err as Error, { alert: text });
    return false;
  }
}

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
      try {
        await quo.sendMessage(recipient, text, sender);
      } catch (err) {
        log.error('watchdog text failed; trying email', err as Error);
        if (!(await emailFallback(text, err as Error))) throw err;
      }
    },
  };
}
