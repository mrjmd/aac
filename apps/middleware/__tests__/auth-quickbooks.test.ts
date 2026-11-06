import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const env = {
  cron: { secret: 'cron-secret' as string | null },
  quickbooks: {
    clientId: 'qb-client',
    clientSecret: 'qb-secret',
    redirectUri: 'https://mw.example.com/api/auth/quickbooks/callback',
    realmId: '9130000000000001',
  },
};
vi.mock('../lib/env.js', () => ({ getEnv: vi.fn(() => env) }));

const redis = { set: vi.fn(), del: vi.fn() };
vi.mock('../lib/redis.js', () => ({ getRedis: vi.fn(() => redis) }));

const saveTokens = vi.fn();
vi.mock('@aac/shared-utils/qbo-tokens', () => ({
  qboTokenStore: vi.fn(() => ({ saveTokens })),
}));

import connect from '../api/auth/quickbooks/connect.js';
import callback from '../api/auth/quickbooks/callback.js';

interface FakeRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  location?: string;
}

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}): VercelRequest {
  return { method: 'GET', query, headers } as unknown as VercelRequest;
}

function makeRes(): { res: VercelResponse; out: FakeRes } {
  const out: FakeRes = { statusCode: 200, body: '', headers: {} };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; return res; },
    status: (code: number) => { out.statusCode = code; return res; },
    send: (body: string) => { out.body = body; return res; },
    json: (body: unknown) => { out.body = JSON.stringify(body); return res; },
    redirect: (code: number, url: string) => { out.statusCode = code; out.location = url; return res; },
  };
  return { res: res as unknown as VercelResponse, out };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  env.cron.secret = 'cron-secret';
  redis.set.mockResolvedValue('OK');
  redis.del.mockResolvedValue(1);
  saveTokens.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: 'AT-secret',
        refresh_token: 'RT-secret',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
        token_type: 'bearer',
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/auth/quickbooks/connect', () => {
  it('401s with no bearer or key, and stores no state', async () => {
    const { res, out } = makeRes();
    await connect(makeReq({}), res);
    expect(out.statusCode).toBe(401);
    expect(out.location).toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('401s with a wrong key or wrong bearer', async () => {
    for (const req of [
      makeReq({ key: 'nope' }),
      makeReq({}, { authorization: 'Bearer nope' }),
      makeReq({}, { authorization: 'cron-secret' }),
    ]) {
      const { res, out } = makeRes();
      await connect(req, res);
      expect(out.statusCode).toBe(401);
    }
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('503s when CRON_SECRET is unset', async () => {
    env.cron.secret = null;
    const { res, out } = makeRes();
    await connect(makeReq({ key: '' }), res);
    expect(out.statusCode).toBe(503);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    ['?key=', makeReq({ key: 'cron-secret' })],
    ['Authorization header', makeReq({}, { authorization: 'Bearer cron-secret' })],
  ])('with %s: stores a random 10-minute state and redirects to Intuit with it', async (_label, req) => {
    const { res, out } = makeRes();
    await connect(req, res);
    expect(out.statusCode).toBe(302);
    const url = new URL(out.location!);
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.set).toHaveBeenCalledWith(`oauth:quickbooks:state:${state}`, '1', { ex: 600 });
    expect(url.searchParams.get('redirect_uri')).toBe(env.quickbooks.redirectUri);
  });

  it('issues a different state each time', async () => {
    const a = makeRes();
    const b = makeRes();
    await connect(makeReq({ key: 'cron-secret' }), a.res);
    await connect(makeReq({ key: 'cron-secret' }), b.res);
    expect(new URL(a.out.location!).searchParams.get('state')).not.toBe(
      new URL(b.out.location!).searchParams.get('state'),
    );
  });
});

describe('GET /api/auth/quickbooks/callback', () => {
  const good = { code: 'auth-code', state: 'nonce-1', realmId: '9130000000000001' };

  it('happy path: consumes the nonce, exchanges the code, saves tokens, echoes no token', async () => {
    const { res, out } = makeRes();
    await callback(makeReq(good), res);
    expect(out.statusCode).toBe(200);
    expect(redis.del).toHaveBeenCalledWith('oauth:quickbooks:state:nonce-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'AT-secret', refreshToken: 'RT-secret', realmId: '9130000000000001' }),
    );
    expect(out.body).not.toContain('AT-secret');
    expect(out.body).not.toContain('RT-secret');
  });

  it('rejects an unknown, expired or reused nonce without exchanging or saving', async () => {
    redis.del.mockResolvedValue(0);
    const { res, out } = makeRes();
    await callback(makeReq(good), res);
    expect(out.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('rejects the old constant state', async () => {
    redis.del.mockResolvedValue(0);
    const { res, out } = makeRes();
    await callback(makeReq({ ...good, state: 'aac-middleware' }), res);
    expect(out.statusCode).toBe(400);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('rejects a missing state without touching Redis', async () => {
    const { res, out } = makeRes();
    await callback(makeReq({ code: 'auth-code', realmId: good.realmId }), res);
    expect(out.statusCode).toBe(400);
    expect(redis.del).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('refuses tokens for a different realm, and does not echo the realm', async () => {
    const { res, out } = makeRes();
    await callback(makeReq({ ...good, realmId: '<b>4620816365000000</b>' }), res);
    expect(out.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(out.body).not.toContain('4620816365000000');
  });

  it('refuses a missing realm', async () => {
    const { res, out } = makeRes();
    await callback(makeReq({ code: 'auth-code', state: 'nonce-1' }), res);
    expect(out.statusCode).toBe(400);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('HTML-escapes the error echo', async () => {
    const { res, out } = makeRes();
    await callback(makeReq({ error: '<script>alert(1)</script>', error_description: '"x" & <img>' }), res);
    expect(out.statusCode).toBe(400);
    expect(out.body).not.toContain('<script>');
    expect(out.body).not.toContain('<img>');
    expect(out.body).toContain('&#60;script&#62;');
  });

  it('does not echo the token-exchange error body', async () => {
    fetchMock.mockResolvedValue(new Response('<script>leak</script> refresh_token=RT', { status: 400 }));
    const { res, out } = makeRes();
    await callback(makeReq(good), res);
    expect(out.statusCode).toBe(500);
    expect(out.body).not.toContain('leak');
    expect(out.body).not.toContain('refresh_token');
    expect(saveTokens).not.toHaveBeenCalled();
  });
});
