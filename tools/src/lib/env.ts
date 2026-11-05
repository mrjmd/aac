/**
 * Env + client setup for every tools/ script: load .env.diagnostic, then
 * build clients exactly the way the apps do (QBO through the shared token
 * store and refresh lock). Scripts call `loadEnv()` first, then the
 * factories they need. Run scripts from the repo root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { GeminiClient } from '@aac/api-clients/gemini';
import { GmailClient } from '@aac/api-clients/gmail';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { qboTokenStore } from '@aac/shared-utils/qbo-tokens';

/** Load `.env.diagnostic` (repo root) without overriding variables already set. */
export function loadEnv(file = '.env.diagnostic'): void {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function redisFromEnv(): Redis {
  return new Redis({ url: requireEnv('UPSTASH_REDIS_REST_URL'), token: requireEnv('UPSTASH_REDIS_REST_TOKEN') });
}

export function quickBooksFromEnv(redis: Redis = redisFromEnv()): QuickBooksClient {
  return new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    ...qboTokenStore(redis),
  });
}

export function quoFromEnv(): QuoClient {
  return new QuoClient({ apiKey: requireEnv('QUO_API_KEY'), phoneNumber: requireEnv('QUO_PHONE_NUMBER') });
}

/** Client default model (the -latest alias); pinned names get retired. */
export function geminiFromEnv(): GeminiClient {
  return new GeminiClient({ apiKey: requireEnv('GEMINI_API_KEY') });
}

export function pipedriveFromEnv(
  extra: Partial<ConstructorParameters<typeof PipedriveClient>[0]> = {},
): PipedriveClient {
  return new PipedriveClient({
    apiKey: requireEnv('PIPEDRIVE_API_KEY'),
    companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
    systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
    ...extra,
  });
}

export function googleOAuthFromEnv(): { clientId: string; clientSecret: string; refreshToken: string } {
  return {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
  };
}

export function calendarFromEnv(): GoogleCalendarClient {
  return new GoogleCalendarClient({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
    oauth: googleOAuthFromEnv(),
  });
}

export function gmailFromEnv(): GmailClient {
  return new GmailClient({ oauth: googleOAuthFromEnv() });
}

export function driveFromEnv(): GoogleDriveClient {
  return new GoogleDriveClient({ oauth: googleOAuthFromEnv() });
}
