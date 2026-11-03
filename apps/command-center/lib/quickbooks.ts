import { QuickBooksClient } from "@aac/api-clients/quickbooks";
import { keys, ttl } from "@aac/shared-utils/redis";
import type { QBOAuthTokens } from "@aac/shared-utils/types";
import { getRedis } from "./redis";

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
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async () =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === "OK",
      release: async () => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  });
}
