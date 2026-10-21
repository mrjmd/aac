/**
 * Ack-fast + intake-scheduling behavior of the Quo webhook (P1,
 * 2026-10-21): the response must go out BEFORE the scheduling dispatch
 * finishes, and a first inbound must arm the 10-min intake window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aac/shared-utils/webhook-signature', () => ({
  verifyOpenPhoneWebhookSignature: vi.fn(() => true),
}));

const redisMocks = vi.hoisted(() => ({
  markEventProcessed: vi.fn().mockResolvedValue(true),
  getPipedriveIdFromPhone: vi.fn().mockResolvedValue('777'),
  readFieldCompletion: vi.fn(),
  storePhoneMapping: vi.fn().mockResolvedValue(undefined),
  trackWebhookProcessed: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
  enqueueQuoteTrigger: vi.fn().mockResolvedValue(undefined),
  scheduleIntakeDraft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/redis.js', () => redisMocks);

vi.mock('../lib/env.js', () => ({
  getEnv: vi.fn(() => ({
    quo: { webhookSecret: 'secret', apiKey: 'k', phoneNumber: '+16176681677' },
    scheduling: {
      stubEventsEnabled: false,
      holdEventsEnabled: false,
      suggestNotesEnabled: false,
      stubAttendeeEmails: [],
    },
  })),
}));

const dispatchStarted = vi.hoisted(() => ({ resolve: undefined as undefined | (() => void) }));
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/scheduling-dispatch.js', () => ({
  dispatchSchedulingIntent: dispatchMock,
}));
vi.mock('../lib/suggestion-note.js', () => ({ maybePostSuggestionNote: vi.fn() }));
vi.mock('../lib/inbound-deal.js', () => ({ ensureInboundLeadDeal: vi.fn() }));
vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(() => ({ logActivity: vi.fn().mockResolvedValue(undefined) })),
  getCalendar: vi.fn(),
  getDrive: vi.fn(),
  getGmail: vi.fn(),
  getGemini: vi.fn(() => ({ extractEntities: vi.fn().mockResolvedValue(null) })),
  getQuickBooks: vi.fn(),
  getQuo: vi.fn(),
}));

import { POST } from '../api/webhooks/quo.js';

function makeMessageEvent(overrides: Record<string, unknown> = {}) {
  return {
    object: {
      id: 'evt-quo-1',
      type: 'message.received',
      createdAt: '2026-10-21T15:00:00Z',
      apiVersion: 'v3',
      data: {
        object: {
          id: 'msg-1',
          object: 'message',
          createdAt: '2026-10-21T15:00:00Z',
          direction: 'incoming',
          from: '+19785550199',
          to: '+16176681677',
          body: 'I have a crack in my basement wall, can you help?',
          ...overrides,
        },
      },
    },
  };
}

function req(payload: unknown): Request {
  return new Request('https://x/api/webhooks/quo', {
    method: 'POST',
    headers: { 'openphone-signature': 'sig' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({ outcome: 'none' });
});

describe('quo webhook ack-fast', () => {
  it('returns 200 before the scheduling dispatch resolves (10/19 incident hardening)', async () => {
    let resolveDispatch!: () => void;
    dispatchMock.mockImplementation(
      () => new Promise<Record<string, string>>((res) => {
        resolveDispatch = () => res({ outcome: 'none' });
      }),
    );
    const res = await POST(req(makeMessageEvent()));
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1); // started…
    resolveDispatch(); // …but the response never waited on it
    expect(dispatchStarted).toBeDefined();
  });

  it('dispatch failures after the ack are surfaced to health, not the caller', async () => {
    dispatchMock.mockRejectedValue(new Error('gemini down'));
    const res = await POST(req(makeMessageEvent()));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(redisMocks.logHealthError).toHaveBeenCalled());
  });
});

describe('first-touch intake scheduling', () => {
  it('arms the 10-min window on an inbound message', async () => {
    await POST(req(makeMessageEvent()));
    expect(redisMocks.scheduleIntakeDraft).toHaveBeenCalledTimes(1);
    const [phone, dueMs] = redisMocks.scheduleIntakeDraft.mock.calls[0];
    expect(phone).toBe('+19785550199');
    expect(dueMs).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(dueMs).toBeLessThan(Date.now() + 11 * 60_000);
  });

  it('does not arm the window for Matt\'s own outbound (message.delivered)', async () => {
    const evt = makeMessageEvent({ direction: 'outgoing', from: '+16176681677', to: '+19785550199' });
    (evt.object as { type: string }).type = 'message.delivered';
    await POST(req(evt));
    expect(redisMocks.scheduleIntakeDraft).not.toHaveBeenCalled();
  });

  it('arms the window for an unanswered incoming call (voicemail path)', async () => {
    const evt = {
      object: {
        id: 'evt-quo-2',
        type: 'call.completed',
        createdAt: '2026-10-21T15:00:00Z',
        apiVersion: 'v3',
        data: {
          object: {
            id: 'call-1',
            object: 'call',
            createdAt: '2026-10-21T15:00:00Z',
            direction: 'incoming',
            from: '+19785550198',
            to: '+16176681677',
            duration: 0,
          },
        },
      },
    };
    await POST(req(evt));
    expect(redisMocks.scheduleIntakeDraft).toHaveBeenCalledWith('+19785550198', expect.any(Number));
  });

  it('does not arm the window for an answered incoming call', async () => {
    const evt = {
      object: {
        id: 'evt-quo-3',
        type: 'call.completed',
        createdAt: '2026-10-21T15:00:00Z',
        apiVersion: 'v3',
        data: {
          object: {
            id: 'call-2',
            object: 'call',
            createdAt: '2026-10-21T15:00:00Z',
            direction: 'incoming',
            from: '+19785550197',
            to: '+16176681677',
            duration: 180,
            answeredAt: '2026-10-21T14:57:00Z',
          },
        },
      },
    };
    await POST(req(evt));
    expect(redisMocks.scheduleIntakeDraft).not.toHaveBeenCalled();
  });
});
