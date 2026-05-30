import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock lib modules before importing the handler — same hoisted pattern
// as the quo-webhook test so the spies are in scope at import time.
const {
  writeProposal,
  appendAgentAuditEntry,
  getQuo,
  sendProposalSms,
} = vi.hoisted(() => ({
  writeProposal: vi.fn(),
  appendAgentAuditEntry: vi.fn(),
  getQuo: vi.fn(),
  sendProposalSms: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  writeProposal,
  appendAgentAuditEntry,
}));
vi.mock('../lib/clients.js', () => ({ getQuo }));
vi.mock('../lib/proposals.js', () => ({ sendProposalSms }));

import { POST } from '../api/proposals.js';
import { resetEnvCache } from '../lib/env.js';

const ORIGINAL_ENV = { ...process.env };
const PROPOSAL_SECRET = 'proposal-shared-secret';

beforeEach(() => {
  vi.clearAllMocks();
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
  process.env.SCHEDULING_PROPOSAL_SECRET = PROPOSAL_SECRET;
  resetEnvCache();

  writeProposal.mockResolvedValue(true);
  appendAgentAuditEntry.mockResolvedValue(undefined);
  getQuo.mockReturnValue({ sendMessage: vi.fn() });
  sendProposalSms.mockResolvedValue('msg_sent_123');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

const validPayload = {
  proposalId: 'prop_01HQTEST',
  directive: {
    id: 'dir_01HQTEST',
    intent: 'quote_approved',
    eventClass: 'job',
    customerName: 'John Smith',
    customerPhone: '+16175550123',
    scopeSummary: 'crack injection on rear wall',
  },
  slot: {
    startIso: '2026-06-02T13:00:00.000Z',
    endIso: '2026-06-02T17:00:00.000Z',
    reasoning: 'next available weekday under soft cap',
  },
  eventDescription: 'Scope:\n- crack injection\n\nAddress: 42 Beacon',
  descriptionUsedFallback: false,
  createdAt: '2026-05-30T12:00:00.000Z',
};

function makeRequest(body: unknown, secret = PROPOSAL_SECRET): Request {
  return new Request('https://agent.example/api/proposals', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-scheduling-proposal-secret': secret,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/proposals (agent)', () => {
  it('returns 503 when SCHEDULING_PROPOSAL_SECRET is unset', async () => {
    delete process.env.SCHEDULING_PROPOSAL_SECRET;
    resetEnvCache();
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(503);
    expect(writeProposal).not.toHaveBeenCalled();
  });

  it('returns 401 on missing secret', async () => {
    const req = new Request('https://agent.example/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 on wrong secret', async () => {
    const res = await POST(makeRequest(validPayload, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('returns 400 on non-JSON body', async () => {
    const req = new Request('https://agent.example/api/proposals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-scheduling-proposal-secret': PROPOSAL_SECRET,
      },
      body: 'not json {',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when proposalId missing', async () => {
    const { proposalId: _unused, ...bad } = validPayload;
    const res = await POST(makeRequest(bad));
    expect(res.status).toBe(400);
  });

  it('returns 400 when slot missing', async () => {
    const { slot: _unused, ...bad } = validPayload;
    const res = await POST(makeRequest(bad));
    expect(res.status).toBe(400);
  });

  it('stores proposal, sends SMS, audits, and returns 200/sent', async () => {
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'sent',
      proposalId: 'prop_01HQTEST',
      smsId: 'msg_sent_123',
    });
    expect(writeProposal).toHaveBeenCalledTimes(1);
    const stored = writeProposal.mock.calls[0][0];
    expect(stored.proposalId).toBe('prop_01HQTEST');
    expect(stored.ownerPhoneE164).toBe('+18287724836');
    expect(sendProposalSms).toHaveBeenCalledTimes(1);
    expect(appendAgentAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'proposal_received',
        caller: '+18287724836',
        role: 'owner',
        eventId: 'prop_01HQTEST',
      }),
    );
  });

  it('returns idempotent without re-sending SMS when proposalId already stored', async () => {
    writeProposal.mockResolvedValueOnce(false);
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'idempotent', proposalId: 'prop_01HQTEST' });
    expect(sendProposalSms).not.toHaveBeenCalled();
    expect(appendAgentAuditEntry).not.toHaveBeenCalled();
  });

  it('records audit even when SMS send fails', async () => {
    sendProposalSms.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.smsId).toBeNull();
    expect(appendAgentAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'proposal_received',
        replyText: expect.stringContaining('SMS send failed'),
      }),
    );
  });

  it('returns 500 when writeProposal throws', async () => {
    writeProposal.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(500);
  });
});
