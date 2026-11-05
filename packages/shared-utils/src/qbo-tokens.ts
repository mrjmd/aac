/**
 * QuickBooks OAuth token persistence in the shared Redis, as the
 * callbacks QuickBooksClient takes. Every app and tool uses this.
 */

import { keys, ttl } from './redis.js';
import type { QBOAuthTokens } from './types.js';

/** The Redis calls the token store needs (structurally satisfied by @upstash/redis). */
export interface QboTokenRedis {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx: true; px: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * The QuickBooksClient token callbacks every app and tool shares: one
 * rolling refresh token in `keys.qbOAuthTokens`, and a single-flight lock
 * around refresh (P4-1). Intuit rotates the refresh token on every grant;
 * two processes refreshing at once can strand every app with a dead
 * token. The lock TTL only guards against a crashed holder.
 */
export function qboTokenStore(redis: QboTokenRedis) {
  return {
    getTokens: async (): Promise<QBOAuthTokens | null> =>
      (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens: QBOAuthTokens): Promise<void> => {
      // Upstash serializes the object itself.
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async (): Promise<boolean> =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === 'OK',
      release: async (): Promise<void> => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  };
}
