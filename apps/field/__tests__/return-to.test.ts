import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildAuthorizeUrl = vi.fn();
vi.mock('@/lib/google-oauth', () => ({
  buildAuthorizeUrl: (origin: string, returnTo: string) => buildAuthorizeUrl(origin, returnTo),
}));

const { GET } = await import('@/app/auth/google/route');

const ORIGIN = 'https://field.attackacrack.com';

beforeEach(() => {
  vi.clearAllMocks();
  buildAuthorizeUrl.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');
});

async function returnToFor(next: string | null): Promise<string> {
  const qs = next === null ? '' : `?next=${encodeURIComponent(next)}`;
  const res = await GET(new NextRequest(`${ORIGIN}/auth/google${qs}`));
  expect(res.status).toBe(307);
  expect(buildAuthorizeUrl).toHaveBeenCalledWith(ORIGIN, expect.any(String));
  return buildAuthorizeUrl.mock.calls[0][1] as string;
}

describe('GET /auth/google return-to', () => {
  it('keeps a same-origin path and query', async () => {
    expect(await returnToFor('/events/abc?tab=photos')).toBe('/events/abc?tab=photos');
  });

  it('defaults to / with no next', async () => {
    expect(await returnToFor(null)).toBe('/');
  });

  it.each(['/\\evil.com', '//evil.com', '/\t/evil.com', 'https://evil.com/x', '/x/..//evil.com'])(
    'sends %j home',
    async (next) => {
      expect(await returnToFor(next)).toBe('/');
    },
  );
});
