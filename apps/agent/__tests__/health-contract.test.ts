/**
 * Reader contract: the agent's error-surface reads `health:errors` entries
 * written by @aac/shared-utils/health (middleware and worker), and writes
 * its own heartbeat through it. Pins the key and the entry shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logHealthError } from '@aac/shared-utils/health';

const { redisMock, list } = vi.hoisted(() => {
  const list: string[] = [];
  return {
    list,
    redisMock: {
      set: vi.fn(),
      lpush: vi.fn(async (_key: string, ...els: string[]) => list.unshift(...els)),
      ltrim: vi.fn(async () => 'OK'),
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      lrange: vi.fn(),
    },
  };
});

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => redisMock),
}));

import { readRecentHealthErrors, writeHeartbeat } from '../lib/redis.js';
import { formatErrorSms } from '../lib/error-surface.js';
import { resetEnvCache } from '../lib/env.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  list.length = 0;
  redisMock.set.mockResolvedValue('OK');
  process.env.PIPEDRIVE_API_KEY = 'pd';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'aac';
  process.env.PIPEDRIVE_SYSTEM_USER_ID = '1';
  process.env.QUO_API_KEY = 'quo';
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+18287724836';
  process.env.UPSTASH_REDIS_REST_URL = 'https://r';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.QUICKBOOKS_CLIENT_ID = 'qb-id';
  process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';
  process.env.QUICKBOOKS_REALM_ID = 'qb-realm';
  process.env.QUICKBOOKS_REDIRECT_URI = 'https://qb-redirect';
  process.env.VERCEL_GIT_COMMIT_SHA = 'sha-1';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe('health:errors written by the shared logHealthError', () => {
  it('reads back as a HealthErrorEntry, whether Upstash hands back the JSON string or the parsed object', async () => {
    await logHealthError(redisMock, 'worker:sweep', 'sweep failed: QBO 503', { route: '/api/sweep' });
    expect(redisMock.lpush).toHaveBeenCalledWith('health:errors', expect.any(String));

    for (const raw of [list[0], JSON.parse(list[0]) as unknown]) {
      redisMock.lrange.mockResolvedValueOnce([raw]);
      const [entry] = await readRecentHealthErrors(10);
      expect(redisMock.lrange).toHaveBeenLastCalledWith('health:errors', 0, 9);
      expect(entry).toMatchObject({
        source: 'worker:sweep',
        message: 'sweep failed: QBO 503',
        details: { route: '/api/sweep' },
        commitSha: 'sha-1',
      });
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
      expect(formatErrorSms(entry)).toContain('src: worker:sweep');
      expect(formatErrorSms(entry).startsWith('[worker error]')).toBe(true);
    }
  });
});

describe('writeHeartbeat', () => {
  it('stamps health:agent:ts with an ISO time', async () => {
    await writeHeartbeat();
    expect(redisMock.set).toHaveBeenCalledWith('health:agent:ts', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });
});
