import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleSignInClient } from '../google-signin.js';

const originalFetch = globalThis.fetch;

function mockFetchOnce(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function makeClient() {
  return new GoogleSignInClient({ clientId: 'CID', clientSecret: 'SECRET' });
}

describe('GoogleSignInClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('authorizeUrl', () => {
    it('defaults to identity scopes with an account picker', () => {
      const url = new URL(makeClient().authorizeUrl({ redirectUri: 'https://cc.test/auth/google/callback', state: 'abc' }));
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id')).toBe('CID');
      expect(url.searchParams.get('redirect_uri')).toBe('https://cc.test/auth/google/callback');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('state')).toBe('abc');
      expect(url.searchParams.get('prompt')).toBe('select_account');
      expect(url.searchParams.has('access_type')).toBe(false);
    });

    it('asks for a refresh token when offline', () => {
      const url = new URL(
        makeClient().authorizeUrl({ redirectUri: 'r', state: 's', scopes: ['openid', 'x'], offline: true }),
      );
      expect(url.searchParams.get('scope')).toBe('openid x');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
    });
  });

  describe('exchangeCode', () => {
    it('posts the code and maps the token response', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
      const mock = mockFetchOnce({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid', id_token: 'IT' });
      const tokens = await makeClient().exchangeCode('CODE', 'https://cc.test/cb');
      expect(tokens).toEqual({
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: Date.parse('2026-11-03T13:00:00Z'),
        scope: 'openid',
        idToken: 'IT',
      });
      const [url, init] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(String(init.body));
      expect(body.get('code')).toBe('CODE');
      expect(body.get('client_secret')).toBe('SECRET');
      expect(body.get('redirect_uri')).toBe('https://cc.test/cb');
      expect(body.get('grant_type')).toBe('authorization_code');
    });

    it('throws with the status on failure', async () => {
      mockFetchOnce({ error: 'invalid_grant' }, 400);
      await expect(makeClient().exchangeCode('BAD', 'r')).rejects.toThrow(/400/);
    });
  });

  describe('fetchUserInfo', () => {
    it('sends the bearer token and returns the profile', async () => {
      const profile = { sub: '1', email: 'matt@attackacrack.com', email_verified: true, name: 'Matt' };
      const mock = mockFetchOnce(profile);
      await expect(makeClient().fetchUserInfo('AT')).resolves.toEqual(profile);
      const [, init] = mock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
    });

    it('throws on a non-OK response', async () => {
      mockFetchOnce('nope', 401);
      await expect(makeClient().fetchUserInfo('AT')).rejects.toThrow(/401/);
    });
  });
});
