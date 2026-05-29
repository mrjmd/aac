import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the lib modules BEFORE importing the handler. Pattern matches
// __tests__/error-surface.test.ts so the hoisted spies are in scope at
// import time.
const {
  markAgentQuoEventProcessed,
  appendAgentAuditEntry,
  getQuo,
  handleInboundAgentMessage,
} = vi.hoisted(() => ({
  markAgentQuoEventProcessed: vi.fn(),
  appendAgentAuditEntry: vi.fn(),
  getQuo: vi.fn(),
  handleInboundAgentMessage: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  markAgentQuoEventProcessed,
  appendAgentAuditEntry,
}));
vi.mock('../lib/clients.js', () => ({ getQuo }));
vi.mock('../lib/inbound-handler.js', () => ({ handleInboundAgentMessage }));

import { POST } from '../api/webhooks/quo.js';
import { resetEnvCache } from '../lib/env.js';

const ORIGINAL_ENV = { ...process.env };
const SECRET_B64 = Buffer.from('test-secret', 'utf8').toString('base64');

function sign(payload: string, ts: string, secret: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${ts}.${payload}`)
    .digest('base64');
}

function makeRequest(body: string, signed: boolean): Request {
  const ts = '1700000000000';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (signed) headers.set('openphone-signature', `hmac;1;${ts};${sign(body, ts, SECRET_B64)}`);
  return new Request('https://agent.example/api/webhooks/quo', {
    method: 'POST',
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PIPEDRIVE_API_KEY = 'pd';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'aac';
  process.env.PIPEDRIVE_SYSTEM_USER_ID = '1';
  process.env.QUO_API_KEY = 'quo';
  process.env.QUO_WEBHOOK_SECRET = SECRET_B64;
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+18287724836';
  process.env.UPSTASH_REDIS_REST_URL = 'https://r';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.QUICKBOOKS_CLIENT_ID = 'qb-id';
  process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';
  process.env.QUICKBOOKS_REALM_ID = 'qb-realm';
  process.env.QUICKBOOKS_REDIRECT_URI = 'https://qb-redirect';
  resetEnvCache();

  markAgentQuoEventProcessed.mockResolvedValue(true);
  appendAgentAuditEntry.mockResolvedValue(undefined);
  getQuo.mockReturnValue({ sendMessage: vi.fn() });
  handleInboundAgentMessage.mockResolvedValue({ decision: 'ack', replyText: 'ok' });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

const validBody = JSON.stringify({
  object: {
    id: 'evt_1',
    type: 'message.received',
    data: {
      object: {
        id: 'msg_1',
        from: '+18287724836',
        to: '+16177660151',
        body: 'hi',
      },
    },
  },
});

describe('POST /api/webhooks/quo (agent)', () => {
  it('rejects with 503 when QUO_WEBHOOK_SECRET is unset', async () => {
    delete process.env.QUO_WEBHOOK_SECRET;
    resetEnvCache();
    const res = await POST(makeRequest(validBody, true));
    expect(res.status).toBe(503);
    expect(handleInboundAgentMessage).not.toHaveBeenCalled();
  });

  it('rejects with 401 when signature is missing', async () => {
    const res = await POST(makeRequest(validBody, false));
    expect(res.status).toBe(401);
    expect(handleInboundAgentMessage).not.toHaveBeenCalled();
  });

  it('rejects with 401 when signature is wrong', async () => {
    const req = new Request('https://x', {
      method: 'POST',
      headers: {
        'openphone-signature': 'hmac;1;1700000000000;not-a-valid-sig',
      },
      body: validBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('200s on duplicate and audits, skipping the handler', async () => {
    markAgentQuoEventProcessed.mockResolvedValueOnce(false);
    const res = await POST(makeRequest(validBody, true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('duplicate');
    expect(handleInboundAgentMessage).not.toHaveBeenCalled();
    expect(appendAgentAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'duplicate', eventId: 'evt_1' }),
    );
  });

  it('dispatches to the core handler and returns 200 with decision', async () => {
    const res = await POST(makeRequest(validBody, true));
    expect(res.status).toBe(200);
    expect(handleInboundAgentMessage).toHaveBeenCalledOnce();
    const [parsed, deps] = handleInboundAgentMessage.mock.calls[0];
    expect(parsed.eventId).toBe('evt_1');
    expect(parsed.from).toBe('+18287724836');
    expect(parsed.to).toBe('+16177660151');
    expect(parsed.body).toBe('hi');
    expect(deps.agentPhoneNumber).toBe('+16177660151');
  });

  it('returns 400 on malformed payload structure', async () => {
    const body = JSON.stringify({ foo: 'bar' });
    const res = await POST(makeRequest(body, true));
    expect(res.status).toBe(400);
  });

  it('returns 200 on handler exception (fail-safe so OpenPhone does not retry)', async () => {
    handleInboundAgentMessage.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(makeRequest(validBody, true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('error');
  });
});
