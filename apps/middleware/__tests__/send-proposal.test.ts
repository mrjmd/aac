import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const {
  mockBuildProposalForDirective,
  mockPostProposalToAgent,
  mockLogHealthError,
  mockVerifyCronAuth,
} = vi.hoisted(() => ({
  mockBuildProposalForDirective: vi.fn(),
  mockPostProposalToAgent: vi.fn(),
  mockLogHealthError: vi.fn(),
  mockVerifyCronAuth: vi.fn(() => true),
}));

vi.mock('../lib/proposal-builder.js', () => ({
  buildProposalForDirective: mockBuildProposalForDirective,
}));
vi.mock('../lib/agent-proposal-post.js', () => ({
  postProposalToAgent: mockPostProposalToAgent,
}));
vi.mock('../lib/redis.js', () => ({ logHealthError: mockLogHealthError }));
vi.mock('../lib/cron.js', () => ({ verifyCronAuth: mockVerifyCronAuth }));
vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(),
  getQuickBooks: vi.fn(),
  getQuo: vi.fn(),
  getGemini: vi.fn(),
  getCalendar: vi.fn(),
}));
vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    scheduling: {
      proposalSecret: 'shared',
      agentBaseUrl: 'https://agent.example',
    },
    nodeEnv: 'development',
  }),
}));

import handler from '../api/scheduling/send-proposal.js';

function makeReq(opts: { method?: string; body?: unknown; query?: Record<string, string> }): VercelRequest {
  return {
    method: opts.method ?? 'POST',
    headers: {},
    body: opts.body,
    query: opts.query ?? {},
  } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { _status: number; _json: unknown } {
  const r: Partial<VercelResponse> & { _status?: number; _json?: unknown } = {};
  r.status = vi.fn((s: number) => {
    r._status = s;
    return r as VercelResponse;
  }) as VercelResponse['status'];
  r.json = vi.fn((j: unknown) => {
    r._json = j;
    return r as VercelResponse;
  }) as VercelResponse['json'];
  return r as VercelResponse & { _status: number; _json: unknown };
}

const builtFixture = {
  payload: {
    proposalId: 'prop_1',
    directive: {
      id: 'dir_1',
      intent: 'quote_approved' as const,
      eventClass: 'job' as const,
      customerName: 'John Smith',
      customerPhone: '+16175550123',
      scopeSummary: 'crack injection',
    },
    slot: {
      startIso: '2026-06-02T13:00:00.000Z',
      endIso: '2026-06-02T17:00:00.000Z',
      reasoning: 'next available',
    },
    eventDescription: 'Scope:\n- crack injection',
    descriptionUsedFallback: false,
    createdAt: '2026-05-30T12:00:00.000Z',
  },
  suggestedSlotFound: true,
  descriptionUsedFallback: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyCronAuth.mockReturnValue(true);
  mockBuildProposalForDirective.mockResolvedValue(builtFixture);
  mockPostProposalToAgent.mockResolvedValue({
    ok: true,
    status: 200,
    smsId: 'sms_1',
    bodyText: '{}',
  });
});

describe('POST /api/scheduling/send-proposal', () => {
  it('rejects PUT/DELETE with 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE', body: {} }), res);
    expect(res._status).toBe(405);
  });

  it('rejects when verifyCronAuth fails', async () => {
    mockVerifyCronAuth.mockImplementation((_req: VercelRequest, res: VercelResponse) => {
      (res.status as ReturnType<typeof vi.fn>)(401);
      return false;
    });
    const res = makeRes();
    await handler(makeReq({ body: { directiveId: 'dir_1' } }), res);
    expect(res._status).toBe(401);
    expect(mockBuildProposalForDirective).not.toHaveBeenCalled();
  });

  it('returns 400 when directiveId missing', async () => {
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('accepts directiveId from query param', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: { directiveId: 'dir_1' } }), res);
    expect(res._status).toBe(200);
    expect(mockBuildProposalForDirective).toHaveBeenCalled();
  });

  it('returns 404 when directive not found', async () => {
    mockBuildProposalForDirective.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(makeReq({ body: { directiveId: 'unknown' } }), res);
    expect(res._status).toBe(404);
  });

  it('returns 200 on full happy path', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { directiveId: 'dir_1' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      ok: true,
      directiveId: 'dir_1',
      proposalId: 'prop_1',
      smsId: 'sms_1',
      suggestedSlotFound: true,
      descriptionUsedFallback: false,
      agentStatus: 200,
    });
  });

  it('returns 502 when agent post fails and records health error', async () => {
    mockPostProposalToAgent.mockResolvedValueOnce({
      ok: false,
      status: 500,
      smsId: null,
      bodyText: null,
    });
    const res = makeRes();
    await handler(makeReq({ body: { directiveId: 'dir_1' } }), res);
    expect(res._status).toBe(502);
    expect(mockLogHealthError).toHaveBeenCalled();
  });

  it('returns 500 when builder throws', async () => {
    mockBuildProposalForDirective.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await handler(makeReq({ body: { directiveId: 'dir_1' } }), res);
    expect(res._status).toBe(500);
    expect(mockLogHealthError).toHaveBeenCalled();
  });
});
