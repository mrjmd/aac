import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const VERIFIER = 'test-verifier-token';

vi.mock('../lib/redis.js', () => ({
  markEventProcessed: vi.fn().mockResolvedValue(true),
  trackWebhookProcessed: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
  writePendingDirective: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: vi.fn(() => ({
    quickbooks: { webhookVerifierToken: VERIFIER },
  })),
}));

const mockQb = {
  getEstimate: vi.fn(),
  getCustomer: vi.fn().mockResolvedValue({
    Id: 'cust-99',
    DisplayName: 'Smith, John',
    PrimaryPhone: { FreeFormNumber: '(617) 555-0123' },
  }),
};
const mockPd = { searchPersonByPhone: vi.fn().mockResolvedValue({ id: 9001 }) };
const mockQuo = {};

vi.mock('../lib/clients.js', () => ({
  getQuickBooks: vi.fn(() => mockQb),
  getPipedrive: vi.fn(() => mockPd),
  getQuo: vi.fn(() => mockQuo),
}));

import { POST, verifyIntuitSignature } from '../api/webhooks/qb.js';
import {
  markEventProcessed,
  trackWebhookProcessed,
  writePendingDirective,
} from '../lib/redis.js';

// ── helpers ───────────────────────────────────────────────────────

function sign(body: string, token = VERIFIER): string {
  return crypto.createHmac('sha256', token).update(body, 'utf8').digest('base64');
}

function makeRequest(body: unknown, opts: { sig?: string; method?: string } = {}): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.sig !== null) headers.set('intuit-signature', opts.sig ?? sign(raw));
  return new Request('https://example.com/api/webhooks/qb', {
    method: opts.method ?? 'POST',
    headers,
    body: raw,
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    specversion: '1.0',
    id: 'evt-1',
    source: '/quickbooks/online/123456',
    type: 'com.intuit.quickbooks.online.estimate.update',
    intuitentityid: 'est-1234',
    intuitaccountid: '123456',
    time: '2026-05-29T15:00:00.000Z',
    ...overrides,
  };
}

function makeAcceptedEstimate(overrides = {}) {
  return {
    Id: 'est-1234',
    SyncToken: '0',
    TxnStatus: 'Accepted',
    CustomerRef: { value: 'cust-99', name: 'Smith, John' },
    Line: [{ Description: 'Waterproof basement', Amount: 5500, DetailType: 'SalesItemLineDetail' }],
    TotalAmt: 5500,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (markEventProcessed as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

// ── tests ─────────────────────────────────────────────────────────

describe('verifyIntuitSignature (unit)', () => {
  it('verifies a correctly-signed body', () => {
    const body = '{"hello":"world"}';
    expect(verifyIntuitSignature(body, sign(body), VERIFIER)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign('{"hello":"world"}');
    expect(verifyIntuitSignature('{"hello":"WORLD"}', sig, VERIFIER)).toBe(false);
  });

  it('rejects with wrong verifier', () => {
    const body = '{"a":1}';
    expect(verifyIntuitSignature(body, sign(body, 'other'), VERIFIER)).toBe(false);
  });

  it('rejects missing signature header', () => {
    expect(verifyIntuitSignature('body', undefined, VERIFIER)).toBe(false);
  });

  it('rejects empty verifier token', () => {
    expect(verifyIntuitSignature('body', 'sig', '')).toBe(false);
  });

  it('does not throw on length-mismatched signatures', () => {
    expect(() => verifyIntuitSignature('body', 'short', VERIFIER)).not.toThrow();
    expect(verifyIntuitSignature('body', 'short', VERIFIER)).toBe(false);
  });
});

describe('QB webhook POST', () => {
  it('returns 401 on invalid signature', async () => {
    const res = await POST(makeRequest({ events: [] }, { sig: 'bad' }));
    expect(res.status).toBe(401);
    expect(writePendingDirective).not.toHaveBeenCalled();
  });

  it('returns 401 on missing signature', async () => {
    const raw = JSON.stringify({ events: [] });
    const req = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const body = 'not json';
    const req = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'intuit-signature': sign(body) },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 200 with no_events when payload is empty', async () => {
    const res = await POST(makeRequest({ events: [] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('no_events');
  });

  it('shadow-queues a directive for an Accepted estimate', async () => {
    mockQb.getEstimate.mockResolvedValueOnce(makeAcceptedEstimate());
    const res = await POST(makeRequest({ events: [makeEvent()] }));
    expect(res.status).toBe(200);
    expect(writePendingDirective).toHaveBeenCalledTimes(1);
    const arg = (writePendingDirective as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.intent).toBe('quote_approved');
    expect(arg.qbEstimateId).toBe('est-1234');
    expect(trackWebhookProcessed).toHaveBeenCalledWith('qb');
  });

  it('does not queue a directive for a Pending estimate (filtered)', async () => {
    mockQb.getEstimate.mockResolvedValueOnce(makeAcceptedEstimate({ TxnStatus: 'Pending' }));
    const res = await POST(makeRequest({ events: [makeEvent()] }));
    expect(res.status).toBe(200);
    expect(writePendingDirective).not.toHaveBeenCalled();
  });

  it('skips duplicate events', async () => {
    (markEventProcessed as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ events: [makeEvent()] }));
    expect(res.status).toBe(200);
    expect(mockQb.getEstimate).not.toHaveBeenCalled();
    expect(writePendingDirective).not.toHaveBeenCalled();
  });

  it('ignores non-estimate-update events', async () => {
    const res = await POST(
      makeRequest({
        events: [makeEvent({ type: 'com.intuit.quickbooks.online.invoice.create' })],
      }),
    );
    expect(res.status).toBe(200);
    expect(mockQb.getEstimate).not.toHaveBeenCalled();
  });

  it('processes multiple events in one notification', async () => {
    mockQb.getEstimate
      .mockResolvedValueOnce(makeAcceptedEstimate({ Id: 'est-A' }))
      .mockResolvedValueOnce(makeAcceptedEstimate({ Id: 'est-B' }));
    const res = await POST(
      makeRequest({
        events: [
          makeEvent({ id: 'e-A', intuitentityid: 'est-A' }),
          makeEvent({ id: 'e-B', intuitentityid: 'est-B' }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(writePendingDirective).toHaveBeenCalledTimes(2);
  });

  it('accepts payload as a bare array (no events: wrapper)', async () => {
    mockQb.getEstimate.mockResolvedValueOnce(makeAcceptedEstimate());
    const res = await POST(makeRequest([makeEvent()]));
    expect(res.status).toBe(200);
    expect(writePendingDirective).toHaveBeenCalledTimes(1);
  });

  it('returns 200 even when normalizer call throws', async () => {
    mockQb.getEstimate.mockRejectedValueOnce(new Error('QB down'));
    const res = await POST(makeRequest({ events: [makeEvent()] }));
    expect(res.status).toBe(200);
    expect(writePendingDirective).not.toHaveBeenCalled();
  });

  it('returns 200 when QB returns null estimate', async () => {
    mockQb.getEstimate.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ events: [makeEvent()] }));
    expect(res.status).toBe(200);
    expect(writePendingDirective).not.toHaveBeenCalled();
  });
});
