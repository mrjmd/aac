/**
 * Client factory — bridges env vars to constructor-configured API clients.
 *
 * Pattern matches apps/middleware/lib/clients.ts: lazily-instantiated
 * singletons. The factory is the ONLY place in apps/agent that reads env
 * vars for API configuration.
 *
 * Note: the Quo client here is configured with the AGENT phone number
 * (the dedicated comms line), not the main business line. Messages sent
 * via this client default to going OUT from the agent line.
 */

import {
  PipedriveClient,
  DEAL_PIPELINE_ID,
  DEAL_STAGE_IDS,
  DEAL_FIELD_HASHES,
} from '@aac/api-clients/pipedrive';
import { QuoClient } from '@aac/api-clients/quo';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { getEnv } from './env.js';
import { getQBTokens, storeQBTokens } from './redis.js';

let _pipedrive: PipedriveClient | null = null;
let _quo: QuoClient | null = null;
let _quickbooks: QuickBooksClient | null = null;
let _calendar: GoogleCalendarClient | null = null;

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
      phoneNumber: env.quo.agentPhoneNumber,
      webhookSecret: env.quo.webhookSecret || '',
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

export function getCalendar(): GoogleCalendarClient {
  if (!_calendar) {
    const env = getEnv();
    if (!env.google.clientId || !env.google.clientSecret || !env.google.refreshToken) {
      throw new Error(
        'Google Calendar requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN'
      );
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
