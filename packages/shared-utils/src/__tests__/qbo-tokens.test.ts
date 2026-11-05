import { describe, it, expect } from 'vitest';
import { qboTokenStore } from '../qbo-tokens';
import { keys } from '../redis';
import type { QBOAuthTokens } from '../types';

function fakeRedis() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | null> {
      return (data.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown, opts?: { nx: true; px: number }): Promise<unknown> {
      if (opts?.nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async del(key: string): Promise<unknown> {
      return data.delete(key) ? 1 : 0;
    },
  };
}

describe('qboTokenStore', () => {
  it('round-trips tokens through the shared key', async () => {
    const redis = fakeRedis();
    const store = qboTokenStore(redis);
    expect(await store.getTokens()).toBeNull();
    const tokens = { accessToken: 'a', refreshToken: 'r' } as unknown as QBOAuthTokens;
    await store.saveTokens(tokens);
    expect(redis.data.get(keys.qbOAuthTokens)).toBe(tokens);
    expect(await store.getTokens()).toBe(tokens);
  });

  it('the refresh lock is single-flight until released', async () => {
    const store = qboTokenStore(fakeRedis());
    expect(await store.refreshLock.acquire()).toBe(true);
    expect(await store.refreshLock.acquire()).toBe(false);
    await store.refreshLock.release();
    expect(await store.refreshLock.acquire()).toBe(true);
  });
});
