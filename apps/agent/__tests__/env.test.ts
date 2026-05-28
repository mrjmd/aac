import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnv, resetEnvCache } from '../lib/env.js';

const REQUIRED_VARS = [
  'PIPEDRIVE_API_KEY',
  'PIPEDRIVE_COMPANY_DOMAIN',
  'PIPEDRIVE_SYSTEM_USER_ID',
  'QUO_API_KEY',
  'MATT_PERSONAL_PHONE_NUMBER',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

const ORIGINAL_ENV = { ...process.env };

function clearEnv(): void {
  for (const k of [
    ...REQUIRED_VARS,
    'QUO_AGENT_PHONE_NUMBER',
    'QUO_WEBHOOK_SECRET',
    'AGENT_USER_ROLES',
    'CRON_SECRET',
    'NODE_ENV',
  ]) {
    delete process.env[k];
  }
}

function setAllRequired(): void {
  process.env.PIPEDRIVE_API_KEY = 'pd-key';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'aac';
  process.env.PIPEDRIVE_SYSTEM_USER_ID = '123';
  process.env.QUO_API_KEY = 'quo-key';
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+18287724836';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
}

beforeEach(() => {
  resetEnvCache();
  clearEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe('getEnv', () => {
  it('throws when a required var is missing', () => {
    expect(() => getEnv()).toThrow(/Missing required environment variable/);
  });

  it('defaults agentPhoneNumber to (617) 766-0151 in E.164', () => {
    setAllRequired();
    expect(getEnv().quo.agentPhoneNumber).toBe('+16177660151');
  });

  it('honors QUO_AGENT_PHONE_NUMBER override', () => {
    setAllRequired();
    process.env.QUO_AGENT_PHONE_NUMBER = '+19998887777';
    expect(getEnv().quo.agentPhoneNumber).toBe('+19998887777');
  });

  it('parses AGENT_USER_ROLES JSON', () => {
    setAllRequired();
    process.env.AGENT_USER_ROLES = JSON.stringify({
      '+18287724836': 'owner',
    });
    expect(getEnv().userRoles).toEqual({ '+18287724836': 'owner' });
  });

  it('defaults userRoles to empty when AGENT_USER_ROLES not set', () => {
    setAllRequired();
    expect(getEnv().userRoles).toEqual({});
  });

  it('defaults nodeEnv to development', () => {
    setAllRequired();
    expect(getEnv().nodeEnv).toBe('development');
  });

  it('caches across calls', () => {
    setAllRequired();
    const first = getEnv();
    const second = getEnv();
    expect(first).toBe(second);
  });

  it('cron.secret is null when not set', () => {
    setAllRequired();
    expect(getEnv().cron.secret).toBeNull();
  });
});
