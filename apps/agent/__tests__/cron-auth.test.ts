import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const env = vi.hoisted(() => ({
  cron: { secret: 'cron-secret' as string | null },
  nodeEnv: 'production' as string,
}));
vi.mock('../lib/env.js', () => ({ getEnv: () => env }));

import { verifyCronAuth } from '../lib/cron.js';

function makeReq(authorization?: string): VercelRequest {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { _status: number | null; _json: unknown } {
  const res = {
    _status: null as number | null,
    _json: undefined as unknown,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body; return res; },
  };
  return res as unknown as VercelResponse & { _status: number | null; _json: unknown };
}

beforeEach(() => {
  env.cron.secret = 'cron-secret';
  env.nodeEnv = 'production';
});

describe('verifyCronAuth', () => {
  it('accepts exactly "Bearer <CRON_SECRET>" and sends nothing', () => {
    const res = makeRes();
    expect(verifyCronAuth(makeReq('Bearer cron-secret'), res)).toBe(true);
    expect(res._status).toBeNull();
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['wrong secret', 'Bearer nope'],
    ['bare secret', 'cron-secret'],
    ['lowercase scheme', 'bearer cron-secret'],
    ['double space', 'Bearer  cron-secret'],
    ['trailing space', 'Bearer cron-secret '],
  ])('401s on %s', (_label, header) => {
    const res = makeRes();
    expect(verifyCronAuth(makeReq(header), res)).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('500s when CRON_SECRET is unset outside development', () => {
    env.cron.secret = null;
    const res = makeRes();
    expect(verifyCronAuth(makeReq('Bearer null'), res)).toBe(false);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Cron not configured' });
  });

  it('401s a bad header in development when CRON_SECRET is set', () => {
    env.nodeEnv = 'development';
    const res = makeRes();
    expect(verifyCronAuth(makeReq('Bearer nope'), res)).toBe(false);
    expect(res._status).toBe(401);
  });

  it('skips auth in development when CRON_SECRET is unset', () => {
    env.cron.secret = null;
    env.nodeEnv = 'development';
    const res = makeRes();
    expect(verifyCronAuth(makeReq(), res)).toBe(true);
    expect(res._status).toBeNull();
  });
});
