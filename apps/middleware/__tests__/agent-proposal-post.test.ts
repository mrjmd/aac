import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postProposalToAgent } from '../lib/agent-proposal-post.js';
import type { ProposalPayload } from '@aac/scheduling';

const payload: ProposalPayload = {
  proposalId: 'prop_1',
  directive: {
    id: 'dir_1',
    intent: 'quote_approved',
    eventClass: 'job',
    customerName: 'John Smith',
    customerPhone: '+16175550123',
    scopeSummary: 'crack injection',
  },
  slot: {
    startIso: '2026-06-02T13:00:00.000Z',
    endIso: '2026-06-02T17:00:00.000Z',
    reasoning: 'next available',
  },
  eventDescription: '...',
  descriptionUsedFallback: false,
  createdAt: '2026-05-30T12:00:00.000Z',
};

describe('postProposalToAgent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns ok=false when base url or secret unset', async () => {
    const res = await postProposalToAgent(payload, {
      agentBaseUrl: null,
      proposalSecret: 'x',
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
  });

  it('POSTs to /api/proposals with the secret header and returns ok+smsId on 2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'sent', proposalId: 'prop_1', smsId: 'sms_42' }), { status: 200 }),
    );
    const res = await postProposalToAgent(payload, {
      agentBaseUrl: 'https://agent.example/',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.smsId).toBe('sms_42');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://agent.example/api/proposals');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'x-scheduling-proposal-secret': 'shared',
    });
  });

  it('returns ok=false on non-2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );
    const res = await postProposalToAgent(payload, {
      agentBaseUrl: 'https://agent.example',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it('returns ok=true even when response body is not JSON', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('not json', { status: 200 }),
    );
    const res = await postProposalToAgent(payload, {
      agentBaseUrl: 'https://agent.example',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.smsId).toBeNull();
  });

  it('returns ok=false when fetch throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network'));
    const res = await postProposalToAgent(payload, {
      agentBaseUrl: 'https://agent.example',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
  });
});
