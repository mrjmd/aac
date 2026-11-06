/**
 * Dependency wiring for the daily triage run (@aac/triage). Reuses the
 * shared Redis/QBO/Quo singletons from getWorkerDeps (which also require
 * QUO_PHONE_NUMBER and GEMINI_API_KEY); calendar and Gmail need the Google
 * env, without which the run doesn't happen at all (logged skip). Gmail is
 * built lazily inside collect's email sweep, so a token without
 * gmail.readonly degrades to the "email sweep failing" system finding,
 * same as the laptop run.
 */
import type { Redis } from '@upstash/redis';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GmailClient } from '@aac/api-clients/gmail';
import { createLogger } from '@aac/shared-utils/logger';
import { technicianEmails } from '@aac/shared-utils/calendar';
import { keys } from '@aac/shared-utils/redis';
import { RedisStaleQuoteStore } from '@aac/stale-quotes';
import { RedisTriageStore, type AnalyzeDeps, type CollectDeps, type StaleQuoteLists } from '@aac/triage';
import { getWorkerDeps } from './deps.js';

const log = createLogger('worker-triage');

export type TriageMode = 'off' | 'dry' | 'live';

export interface TriageDeps {
  redis: Redis;
  collect: CollectDeps;
  analyze: AnalyzeDeps;
  /** That morning's stale-quote queue + awaiting-reply list (@aac/stale-quotes). */
  loadStaleLists: () => Promise<StaleQuoteLists>;
}

/** The env each client needs, grouped; the first group with a gap names the skip. */
const ENV_GROUPS: Array<[group: string, names: string[]]> = [
  ['redis', ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']],
  ['qbo', ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_REALM_ID', 'QUICKBOOKS_REDIRECT_URI']],
  ['quo', ['QUO_API_KEY', 'QUO_PHONE_NUMBER']],
  ['gemini', ['GEMINI_API_KEY']],
  ['google', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']],
];

/**
 * `no-<group>-env` (e.g. `no-google-env`) for the first env group with an
 * unset variable, or null when the run can build every client. Checked
 * before anything else so a gap is a logged skip, never a crash.
 */
export function missingTriageEnv(): string | null {
  for (const [group, names] of ENV_GROUPS) {
    const unset = names.filter((n) => !process.env[n]);
    if (unset.length) {
      log.warn(`triage disabled: ${unset.join(', ')} not set`);
      return `no-${group}-env`;
    }
  }
  return null;
}

let cached: TriageDeps | null = null;

/** Call only after missingTriageEnv() returned null (getWorkerDeps throws on a gap). */
export function getTriageDeps(): TriageDeps {
  if (cached) return cached;
  const { deps, redis } = getWorkerDeps();
  const oauth = {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
  };
  const store = new RedisTriageStore(redis);
  const quoPhoneNumber = process.env.QUO_PHONE_NUMBER ?? '';
  const now = () => Date.now();
  const logLine = (line: string) => {
    if (line.trim()) log.info(line.trim());
  };
  const staleStore = new RedisStaleQuoteStore(redis);
  cached = {
    redis,
    collect: {
      redis,
      qb: deps.qb,
      quo: deps.quo,
      calendar: new GoogleCalendarClient({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com', oauth }),
      gmail: () => new GmailClient({ oauth }),
      store,
      quoPhoneNumber,
      now,
      log: logLine,
    },
    analyze: {
      geminiApiKey: process.env.GEMINI_API_KEY ?? '',
      store,
      quoPhoneNumber,
      technicianEmails: technicianEmails(process.env.TECHNICIAN_EMAILS),
      now,
      log: logLine,
    },
    loadStaleLists: async () => {
      const [queue, awaiting] = await Promise.all([staleStore.loadQueue(), staleStore.loadAwaiting()]);
      return { queue, awaiting };
    },
  };
  return cached;
}

/** Redis `triage:mode` (off | dry | live). Unset = off. */
export async function triageMode(): Promise<TriageMode> {
  const { redis } = getWorkerDeps();
  const m = await redis.get<string>(keys.triageMode);
  return m === 'dry' || m === 'live' ? m : 'off';
}
