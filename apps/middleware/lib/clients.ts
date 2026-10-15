/**
 * Client factory — bridges env vars to constructor-configured API clients.
 *
 * Each client is lazily instantiated as a singleton. The factory is the
 * ONLY place in the middleware that reads env vars for API configuration.
 */

import {
  PipedriveClient,
  DEAL_PIPELINE_ID,
  DEAL_STAGE_IDS,
  DEAL_FIELD_HASHES,
} from '@aac/api-clients/pipedrive';
import { QuoClient } from '@aac/api-clients/quo';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { GeminiClient } from '@aac/api-clients/gemini';
import { GmailClient } from '@aac/api-clients/gmail';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { GoogleMapsClient } from '@aac/api-clients/google-maps';
import { getEnv } from './env.js';
import { getQBTokens, storeQBTokens } from './redis.js';

let _pipedrive: PipedriveClient | null = null;
let _quo: QuoClient | null = null;
let _quickbooks: QuickBooksClient | null = null;
let _gemini: GeminiClient | null = null;
let _calendar: GoogleCalendarClient | null = null;
let _drive: GoogleDriveClient | null = null;
let _gmail: GmailClient | null = null;
let _maps: GoogleMapsClient | null = null;

export function getPipedrive(): PipedriveClient {
  if (!_pipedrive) {
    const env = getEnv();
    _pipedrive = new PipedriveClient({
      apiKey: env.pipedrive.apiKey,
      companyDomain: env.pipedrive.companyDomain,
      systemUserId: env.pipedrive.systemUserId,
      dealSpine: {
        pipelineId: DEAL_PIPELINE_ID,
        stageIds: DEAL_STAGE_IDS,
        fieldHashes: DEAL_FIELD_HASHES,
      },
    });
  }
  return _pipedrive;
}

export function getQuo(): QuoClient {
  if (!_quo) {
    const env = getEnv();
    _quo = new QuoClient({
      apiKey: env.quo.apiKey,
      phoneNumber: env.quo.phoneNumber,
      webhookSecret: env.quo.webhookSecret,
    });
  }
  return _quo;
}

export function getQuickBooks(): QuickBooksClient {
  if (!_quickbooks) {
    const env = getEnv();
    _quickbooks = new QuickBooksClient({
      clientId: env.quickbooks.clientId,
      clientSecret: env.quickbooks.clientSecret,
      realmId: env.quickbooks.realmId,
      redirectUri: env.quickbooks.redirectUri,
      getTokens: getQBTokens,
      saveTokens: storeQBTokens,
    });
  }
  return _quickbooks;
}

export function getGemini(): GeminiClient {
  if (!_gemini) {
    const env = getEnv();
    _gemini = new GeminiClient({
      apiKey: env.gemini.apiKey || '',
    });
  }
  return _gemini;
}

export function getMaps(): GoogleMapsClient | null {
  if (!_maps) {
    const env = getEnv();
    if (!env.googleMaps.apiKey) return null;
    _maps = new GoogleMapsClient({ apiKey: env.googleMaps.apiKey });
  }
  return _maps;
}

/**
 * Drive client on the same OAuth token as Calendar. Returns null when the
 * Google creds are absent OR the token lacks Drive scope at runtime —
 * callers treat null/failed Drive as "skip photo attachments", never fatal.
 */
export function getDrive(): GoogleDriveClient | null {
  if (!_drive) {
    const env = getEnv();
    if (!env.google.clientId || !env.google.clientSecret || !env.google.refreshToken) {
      return null;
    }
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

/**
 * Gmail client on the same OAuth token as Calendar/Drive. Returns null
 * when the Google creds are absent OR the token lacks gmail.readonly at
 * runtime — callers treat null/failed Gmail as "skip email photos".
 */
export function getGmail(): GmailClient | null {
  if (!_gmail) {
    const env = getEnv();
    if (!env.google.clientId || !env.google.clientSecret || !env.google.refreshToken) {
      return null;
    }
    _gmail = new GmailClient({
      oauth: {
        clientId: env.google.clientId,
        clientSecret: env.google.clientSecret,
        refreshToken: env.google.refreshToken,
      },
    });
  }
  return _gmail;
}

export function getCalendar(): GoogleCalendarClient {
  if (!_calendar) {
    const env = getEnv();
    if (!env.google.clientId || !env.google.clientSecret || !env.google.refreshToken) {
      throw new Error('Google Calendar requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
    }
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
