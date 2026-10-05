import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const REQUIRED_ENV: Record<string, string> = {
  PIPEDRIVE_API_KEY: 'pd-key',
  PIPEDRIVE_COMPANY_DOMAIN: 'example.pipedrive.com',
  PIPEDRIVE_SYSTEM_USER_ID: '1',
  QUO_API_KEY: 'quo-key',
  QUO_WEBHOOK_SECRET: 'quo-secret',
  QUO_PHONE_NUMBER: '+15555550100',
  QUICKBOOKS_CLIENT_ID: 'qb-id',
  QUICKBOOKS_CLIENT_SECRET: 'qb-secret',
  QUICKBOOKS_REALM_ID: 'qb-realm',
  QUICKBOOKS_REDIRECT_URI: 'https://example.com/cb',
  ALERT_PHONE_NUMBER: '+15555550101',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
};

async function freshGetEnv() {
  vi.resetModules();
  const mod = await import('../lib/env.js');
  return mod.getEnv();
}

describe('env: stubAttendeeEmails', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(REQUIRED_ENV)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to only the work address — never the legacy gmail', async () => {
    const env = await freshGetEnv();
    expect(env.scheduling.stubAttendeeEmails).toEqual(['mike@attackacrack.com']);
  });

  it('parses STUB_ATTENDEE_EMAILS as a trimmed comma list', async () => {
    vi.stubEnv('STUB_ATTENDEE_EMAILS', ' a@x.com , b@y.com ,');
    const env = await freshGetEnv();
    expect(env.scheduling.stubAttendeeEmails).toEqual(['a@x.com', 'b@y.com']);
  });

  it('keeps the broad TECHNICIAN_EMAILS read-filter default unchanged', async () => {
    const env = await freshGetEnv();
    expect(env.google.technicianEmails).toEqual([
      'mike@attackacrack.com',
      'harrringtonm@gmail.com',
    ]);
  });
});
