import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet, delete: vi.fn() }),
}));

const redisGet = vi.fn();
vi.mock('@/lib/clients', () => ({
  getRedis: () => ({ get: redisGet, set: vi.fn().mockResolvedValue('OK'), del: vi.fn() }),
}));

const { authBypassEmail } = await import('@/lib/auth-bypass');
const { getCurrentSession } = await import('@/lib/session');
const { middleware } = await import('@/middleware');

const saved = { bypass: process.env.FIELD_AUTH_BYPASS_EMAIL, vercelEnv: process.env.VERCEL_ENV };

function setEnv(vercelEnv: string | undefined, bypass: string | undefined) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  if (bypass === undefined) delete process.env.FIELD_AUTH_BYPASS_EMAIL;
  else process.env.FIELD_AUTH_BYPASS_EMAIL = bypass;
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  redisGet.mockResolvedValue(null);
});

afterEach(() => setEnv(saved.vercelEnv, saved.bypass));

describe('authBypassEmail', () => {
  it('is ignored in production', () => {
    setEnv('production', 'Mike@Example.com');
    expect(authBypassEmail()).toBeUndefined();
  });

  it('is honored on preview and locally (lowercased)', () => {
    setEnv('preview', ' Mike@Example.com ');
    expect(authBypassEmail()).toBe('mike@example.com');
    setEnv(undefined, 'mike@example.com');
    expect(authBypassEmail()).toBe('mike@example.com');
  });

  it('is off when unset or blank', () => {
    setEnv('preview', undefined);
    expect(authBypassEmail()).toBeUndefined();
    setEnv('preview', '   ');
    expect(authBypassEmail()).toBeUndefined();
  });
});

describe('getCurrentSession', () => {
  it('does not fabricate a session in production', async () => {
    setEnv('production', 'mike@example.com');
    expect(await getCurrentSession()).toBeNull();
    expect(cookieGet).toHaveBeenCalled();
  });

  it('fabricates the preview session outside production', async () => {
    setEnv('preview', 'mike@example.com');
    const s = await getCurrentSession();
    expect(s?.email).toBe('mike@example.com');
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('still returns a real session in production', async () => {
    setEnv('production', 'mike@example.com');
    cookieGet.mockReturnValue({ value: 'sid' });
    redisGet.mockResolvedValue({ email: 'mike@aac.com', name: 'Mike', createdAt: 'x', lastUsedAt: 'x' });
    expect((await getCurrentSession())?.email).toBe('mike@aac.com');
  });
});

describe('middleware', () => {
  const req = () => new NextRequest('https://field.example.com/events/1');

  it('redirects to /login in production even with the bypass set', () => {
    setEnv('production', 'mike@example.com');
    const res = middleware(req());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('passes through on preview with the bypass set', () => {
    setEnv('preview', 'mike@example.com');
    const res = middleware(req());
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
