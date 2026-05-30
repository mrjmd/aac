import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postProposalDecision } from '../lib/middleware-callback.js';
import type { ProposalDecisionPayload } from '@aac/scheduling';

const payload: ProposalDecisionPayload = {
  proposalId: 'prop_1',
  directiveId: 'dir_1',
  decision: 'approved',
  replyText: 'yes',
  decidedAt: '2026-05-30T12:00:00.000Z',
};

describe('postProposalDecision', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns false when middlewareBaseUrl is null', async () => {
    const fetchSpy = vi.fn();
    const ok = await postProposalDecision(payload, {
      middlewareBaseUrl: null,
      proposalSecret: 'secret',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns false when proposalSecret is null', async () => {
    const fetchSpy = vi.fn();
    const ok = await postProposalDecision(payload, {
      middlewareBaseUrl: 'https://mw.example',
      proposalSecret: null,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /api/scheduling/proposal-decision with auth header and returns true on 2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const ok = await postProposalDecision(payload, {
      middlewareBaseUrl: 'https://mw.example/',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://mw.example/api/scheduling/proposal-decision');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-scheduling-proposal-secret': 'shared',
    });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('returns false on non-2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );
    const ok = await postProposalDecision(payload, {
      middlewareBaseUrl: 'https://mw.example',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    const ok = await postProposalDecision(payload, {
      middlewareBaseUrl: 'https://mw.example',
      proposalSecret: 'shared',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});
