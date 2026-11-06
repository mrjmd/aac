/**
 * Client/dependency wiring for the drafts worker. One module-level
 * singleton per lambda instance, same construction as the laptop runner.
 */
import { Redis } from '@upstash/redis';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { GeminiClient } from '@aac/api-clients/gemini';
import { RedisDraftState, type DraftDeps } from '@aac/message-drafts';
import { CanHelpStore } from '@aac/quoting';
import { qboTokenStore } from '@aac/shared-utils/qbo-tokens';
import { countCondition } from './conditions.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let cached: { deps: DraftDeps; redis: Redis } | null = null;

export function getWorkerDeps(): { deps: DraftDeps; redis: Redis } {
  if (cached) return cached;
  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    ...qboTokenStore(redis),
  });
  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });
  const gemini = new GeminiClient({ apiKey: requireEnv('GEMINI_API_KEY') });
  cached = {
    deps: { qb, quo, gemini, state: new RedisDraftState(redis), canHelp: new CanHelpStore(redis), countCondition: (name) => countCondition(name) },
    redis,
  };
  return cached;
}
