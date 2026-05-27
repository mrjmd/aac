/**
 * Lazy-initialized clients for external services.
 *
 * Pattern mirrors apps/middleware/lib/clients.ts. Each getter caches its
 * client across requests (Vercel keeps module state warm within a function
 * instance, so this is effectively a per-instance singleton).
 */

import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { getEnv } from './env';

let _calendar: GoogleCalendarClient | null = null;
let _drive: GoogleDriveClient | null = null;
let _pipedrive: PipedriveClient | null = null;
let _quickbooks: QuickBooksClient | null = null;
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const env = getEnv();
    _redis = new Redis({ url: env.redis.url, token: env.redis.token });
  }
  return _redis;
}

export function getDrive(): GoogleDriveClient {
  if (!_drive) {
    const env = getEnv();
    _drive = new GoogleDriveClient({
      oauth: {
        clientId: env.google.clientId,
        clientSecret: env.google.clientSecret,
        refreshToken: env.google.refreshToken,
      },
    });
  }
  return _drive;
}

export function getPipedrive(): PipedriveClient {
  if (!_pipedrive) {
    const env = getEnv();
    _pipedrive = new PipedriveClient({
      apiKey: env.pipedrive.apiKey,
      companyDomain: env.pipedrive.companyDomain,
    });
  }
  return _pipedrive;
}

export function getQuickBooks(): QuickBooksClient {
  if (!_quickbooks) {
    const env = getEnv();
    _quickbooks = new QuickBooksClient({
      clientId: env.quickbooks.clientId,
      clientSecret: env.quickbooks.clientSecret,
      realmId: env.quickbooks.realmId,
      // OAuth connect flow is owned by middleware; field never initiates it.
      redirectUri: '',
      getTokens: getQBTokens,
      saveTokens: storeQBTokens,
    });
  }
  return _quickbooks;
}

// ── QuickBooks token storage (shared with middleware) ─────────────────

async function getQBTokens(): Promise<QBOAuthTokens | null> {
  return (await getRedis().get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null;
}

async function storeQBTokens(tokens: QBOAuthTokens): Promise<void> {
  await getRedis().set(keys.qbOAuthTokens, tokens);
}

export function getCalendar(): GoogleCalendarClient {
  if (!_calendar) {
    const env = getEnv();
    _calendar = new GoogleCalendarClient({
      calendarId: env.google.calendarId,
      oauth: {
        clientId: env.google.clientId,
        clientSecret: env.google.clientSecret,
        refreshToken: env.google.refreshToken,
      },
    });
  }
  return _calendar;
}
