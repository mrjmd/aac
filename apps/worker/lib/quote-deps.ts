/**
 * Dependency wiring for the quote-drafter pipeline. Reuses the shared
 * QBO/Quo singletons from getWorkerDeps and adds the drafter-specific
 * pieces: a Gemini client pinned to the drafter's model (thinkingBudget
 * parity with the laptop CLI) and the optional Google calendar/drive
 * channel (absence just disables field context + T2).
 */
import { GeminiClient } from '@aac/api-clients/gemini';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { createLogger } from '@aac/shared-utils/logger';
import type { DrafterDeps, DrafterMode } from '@aac/quote-drafter';
import { getWorkerDeps } from './deps.js';

const log = createLogger('worker-quote-drafter');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let cached: DrafterDeps | null = null;

export function getQuoteDeps(): DrafterDeps {
  if (cached) return cached;
  const { deps, redis } = getWorkerDeps();
  const gemini = new GeminiClient({
    apiKey: requireEnv('GEMINI_API_KEY'),
    textModel: 'gemini-3.6-flash',
  });
  let calendar: GoogleCalendarClient | null = null;
  let drive: GoogleDriveClient | null = null;
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth = {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
    };
    calendar = new GoogleCalendarClient({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
      oauth,
    });
    drive = new GoogleDriveClient({ oauth });
  }
  cached = {
    redis,
    qb: deps.qb,
    quo: deps.quo,
    gemini,
    calendar,
    drive,
    log: (line) => log.info(line),
    now: () => Date.now(),
  };
  return cached;
}

export function envMode(): DrafterMode {
  const m = process.env.QUOTE_DRAFTER_MODE;
  return m === 'live' || m === 'shadow' ? m : 'off';
}
