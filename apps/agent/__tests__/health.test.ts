import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { heartbeatSpy } = vi.hoisted(() => ({ heartbeatSpy: vi.fn() }));
vi.mock('../lib/redis.js', () => ({
  writeHeartbeat: heartbeatSpy,
}));

import handler from '../api/health.js';
import { resetEnvCache } from '../lib/env.js';

const ORIGINAL_ENV = { ...process.env };

function setRequired(): void {
  process.env.PIPEDRIVE_API_KEY = 'pd-key';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'aac';
  process.env.PIPEDRIVE_SYSTEM_USER_ID = '123';
  process.env.QUO_API_KEY = 'quo-key';
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+18287724836';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  process.env.QUICKBOOKS_CLIENT_ID = 'qb-id';
  process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';
  process.env.QUICKBOOKS_REALM_ID = 'qb-realm';
  process.env.QUICKBOOKS_REDIRECT_URI = 'https://qb-redirect';
}

function makeReq(method = 'GET') {
  return { method } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  heartbeatSpy.mockResolvedValue(undefined);
  resetEnvCache();
  setRequired();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe('agent /api/health', () => {
  it('returns 405 for non-GET', async () => {
    const res = makeRes();
    await handler(makeReq('POST'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('writes heartbeat and returns healthy 200', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    expect(heartbeatSpy).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('healthy');
    expect(body.app).toBe('agent');
    expect(body.env.agentPhoneNumber).toBe('+16177660151');
    expect(body.env.userRoleCount).toBe(0);
  });

  it('returns 500 if heartbeat fails', async () => {
    heartbeatSpy.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('error');
    expect(body.error).toBe('redis down');
  });
});
