/**
 * Client factory — bridges env vars to constructor-configured API clients.
 *
 * Each client is lazily instantiated as a singleton. The factory is the
 * ONLY place in the middleware that reads env vars for API configuration.
 */

import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { QuoClient } from '@aac/api-clients/quo';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { GeminiClient } from '@aac/api-clients/gemini';
import { getEnv } from './env.js';
import { getQBTokens, storeQBTokens } from './redis.js';

let _pipedrive: PipedriveClient | null = null;
let _quo: QuoClient | null = null;
let _quickbooks: QuickBooksClient | null = null;
let _gemini: GeminiClient | null = null;

export function getPipedrive(): PipedriveClient {
  if (!_pipedrive) {
    const env = getEnv();
    _pipedrive = new PipedriveClient({
      apiKey: env.pipedrive.apiKey,
      companyDomain: env.pipedrive.companyDomain,
      systemUserId: env.pipedrive.systemUserId,
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
