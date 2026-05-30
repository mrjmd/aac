import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const { mockRecordProposalDecision, mockLogHealthError } = vi.hoisted(() => ({
  mockRecordProposalDecision: vi.fn(),
  mockLogHealthError: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  recordProposalDecision: mockRecordProposalDecision,
  logHealthError: mockLogHealthError,
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    scheduling: { proposalSecret: 'shared-secret', agentBaseUrl: 'https://agent.example' },
    nodeEnv: 'development',
  }),
}));

import handler from '../api/scheduling/proposal-decision.js';

function makeReq(opts: {
  method?: string;
  secret?: string | null;
  body?: unknown;
}): VercelRequest {
  return {
    method: opts.method ?? 'POST',
    headers: opts.secret === undefined
      ? { 'x-scheduling-proposal-secret': 'shared-secret' }
      : opts.secret === null
        ? {}
        : { 'x-scheduling-proposal-secret': opts.secret },
    body: opts.body,
    query: {},
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

const validBody = {
  proposalId: 'prop_1',
  directiveId: 'dir_1',
  decision: 'approved',
  replyText: 'yes',
  decidedAt: '2026-05-30T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordProposalDecision.mockResolvedValue(undefined);
});

describe('POST /api/scheduling/proposal-decision', () => {
  it('rejects non-POST methods with 405', async () => {
    const req = makeReq({ method: 'GET', body: validBody });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 on missing/wrong secret', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: null, body: validBody }), res);
    expect(res._status).toBe(401);

    const res2 = makeRes();
    await handler(makeReq({ secret: 'wrong', body: validBody }), res2);
    expect(res2._status).toBe(401);
  });

  it('returns 400 on missing proposalId', async () => {
    const { proposalId: _unused, ...bad } = validBody;
    const res = makeRes();
    await handler(makeReq({ body: bad }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 on bad decision value', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...validBody, decision: 'maybe' } }), res);
    expect(res._status).toBe(400);
  });

  it('records the decision and returns 200', async () => {
    const res = makeRes();
    await handler(makeReq({ body: validBody }), res);
    expect(res._status).toBe(200);
    expect(mockRecordProposalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'prop_1',
        directiveId: 'dir_1',
        decision: 'approved',
        replyText: 'yes',
        decidedAt: '2026-05-30T12:00:00.000Z',
        recordedAt: expect.any(String),
      }),
    );
    expect(res._json).toEqual({ status: 'recorded', proposalId: 'prop_1' });
  });

  it('returns 500 + logHealthError when recordProposalDecision throws', async () => {
    mockRecordProposalDecision.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    await handler(makeReq({ body: validBody }), res);
    expect(res._status).toBe(500);
    expect(mockLogHealthError).toHaveBeenCalled();
  });
});
