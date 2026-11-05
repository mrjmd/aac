import { QuickBooksClient } from "@aac/api-clients/quickbooks";
import { getRedis } from "./redis";
import { qboTokenStore } from "@aac/shared-utils/qbo-tokens";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/**
 * QBO client on the shared Redis token store, with the single-flight
 * refresh lock (audit P4-1) so this app never races the middleware's
 * token refresh. Same wiring as apps/worker/lib/deps.ts.
 */
export function getQuickBooks(): QuickBooksClient {
  const redis = getRedis();
  return new QuickBooksClient({
    clientId: requireEnv("QUICKBOOKS_CLIENT_ID"),
    clientSecret: requireEnv("QUICKBOOKS_CLIENT_SECRET"),
    realmId: requireEnv("QUICKBOOKS_REALM_ID"),
    redirectUri: requireEnv("QUICKBOOKS_REDIRECT_URI"),
    ...qboTokenStore(redis),
  });
}
