/**
 * Dependency wiring for the stale-quote follow-up scan. Reuses the shared
 * QBO/Quo singletons from getWorkerDeps; calendar and Gmail are hard gates
 * (plan §4.3), so without the Google env the scan doesn't run at all.
 */
import { GeminiClient } from '@aac/api-clients/gemini';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GmailClient } from '@aac/api-clients/gmail';
import { createLogger } from '@aac/shared-utils/logger';
import { technicianEmails } from '@aac/shared-utils/calendar';
import { keys } from '@aac/shared-utils/redis';
import { RedisStaleQuoteStore, type StaleQuoteDeps } from '@aac/stale-quotes';
import { getWorkerDeps } from './deps.js';

const log = createLogger('worker-stale-quotes');

export type StaleQuotesMode = 'off' | 'dry' | 'live';

let cached: StaleQuoteDeps | null = null;

/** Null when the Google env is missing (logged skip). */
export function getStaleQuoteDeps(): StaleQuoteDeps | null {
  if (cached) return cached;
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const { deps, redis } = getWorkerDeps();
  const oauth = { clientId, clientSecret, refreshToken };
  cached = {
    qb: deps.qb,
    quo: deps.quo,
    // Client default model (the -latest alias), same as the laptop runner.
    gemini: new GeminiClient({ apiKey: process.env.GEMINI_API_KEY! }),
    calendar: new GoogleCalendarClient({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com', oauth }),
    gmail: new GmailClient({ oauth }),
    store: new RedisStaleQuoteStore(redis),
    techEmails: technicianEmails(process.env.TECHNICIAN_EMAILS),
    log: (line) => {
      if (line.trim()) log.info(line.trim());
    },
  };
  return cached;
}

/** Redis `stale-quotes:mode` (off | dry | live). Unset = off. */
export async function staleQuotesMode(): Promise<StaleQuotesMode> {
  const { redis } = getWorkerDeps();
  const m = await redis.get<string>(keys.staleQuotesMode);
  return m === 'dry' || m === 'live' ? m : 'off';
}
