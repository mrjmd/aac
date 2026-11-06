/**
 * Ack-fast + intake-scheduling behavior of the Quo webhook (P1,
 * 2026-10-21; customer sync deferred 2026-11-05): the response must go out
 * BEFORE the Pipedrive sync, AI extraction and scheduling dispatch finish,
 * and a first inbound must arm the 10-min intake window.
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
  scheduleInboundSettle: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@aac/scheduling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aac/scheduling')>()),
  dispatchSchedulingIntent: dispatchMock,
}));
vi.mock('../lib/suggestion-note.js', () => ({ maybePostSuggestionNote: vi.fn() }));
vi.mock('../lib/inbound-deal.js', () => ({ ensureInboundLeadDeal: vi.fn() }));
const pdMock = vi.hoisted(() => ({
  logActivity: vi.fn(),
  updatePersonIncremental: vi.fn(),
}));
const extractEntitiesMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(() => pdMock),
  getCalendar: vi.fn(),
  getDrive: vi.fn(),
  getGmail: vi.fn(),
  getGemini: vi.fn(() => ({ extractEntities: extractEntitiesMock })),
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
  pdMock.logActivity.mockResolvedValue(undefined);
  pdMock.updatePersonIncremental.mockResolvedValue({ updated: false, fields: [] });
  extractEntitiesMock.mockResolvedValue(null);
});

/** A call that never settles: the webhook must respond without it. */
const never = (): Promise<never> => new Promise<never>(() => {});

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
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1)); // started…
    resolveDispatch(); // …but the response never waited on it
    expect(dispatchStarted).toBeDefined();
  });

  it('returns 200 before the Pipedrive activity log resolves', async () => {
    pdMock.logActivity.mockReturnValue(never());
    const res = await POST(req(makeMessageEvent()));
    expect(await res.json()).toMatchObject({ status: 'accepted', eventType: 'message.received' });
    await vi.waitFor(() => expect(pdMock.logActivity).toHaveBeenCalledTimes(1));
    expect(dispatchMock).not.toHaveBeenCalled(); // still waiting on Pipedrive, in order
  });

  it('returns 200 before AI entity extraction resolves', async () => {
    extractEntitiesMock.mockReturnValue(never());
    const res = await POST(req(makeMessageEvent()));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(extractEntitiesMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('extracted entities still update the Pipedrive person, then dispatch runs', async () => {
    extractEntitiesMock.mockResolvedValue({
      fullName: 'Dana Whitfield',
      email: 'dana@example.com',
      streetAddress: '12 Elm St',
      city: 'Quincy',
      state: 'MA',
      zipCode: '02169',
      confidence: 0.9,
    });
    await POST(req(makeMessageEvent({ body: 'Hi this is Dana Whitfield, 12 Elm St Quincy MA 02169' })));
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(pdMock.updatePersonIncremental).toHaveBeenCalledWith(777, expect.objectContaining({
      name: 'Dana Whitfield',
      phone: '+19785550199',
      email: 'dana@example.com',
      city: 'Quincy',
    }));
    expect(redisMocks.trackWebhookProcessed).toHaveBeenCalledWith('quo');
  });

  it('a Pipedrive failure after the ack is surfaced to health and skips dispatch, as before', async () => {
    pdMock.logActivity.mockRejectedValue(new Error('pipedrive 503'));
    const res = await POST(req(makeMessageEvent()));
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(redisMocks.logHealthError).toHaveBeenCalledWith('quo', 'pipedrive 503', { eventId: 'evt-quo-1' }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(redisMocks.trackWebhookProcessed).not.toHaveBeenCalled();
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

  it('bumps the inbound router settle clock on the same events', async () => {
    const before = Date.now();
    await POST(req(makeMessageEvent()));
    expect(redisMocks.scheduleInboundSettle).toHaveBeenCalledTimes(1);
    const [phone, nowMs] = redisMocks.scheduleInboundSettle.mock.calls[0];
    expect(phone).toBe('+19785550199');
    expect(nowMs).toBeGreaterThanOrEqual(before);
    expect(nowMs).toBeLessThanOrEqual(Date.now());
  });

  it('does not arm the window for Matt\'s own outbound (message.delivered)', async () => {
    const evt = makeMessageEvent({ direction: 'outgoing', from: '+16176681677', to: '+19785550199' });
    (evt.object as { type: string }).type = 'message.delivered';
    await POST(req(evt));
    expect(redisMocks.scheduleIntakeDraft).not.toHaveBeenCalled();
    expect(redisMocks.scheduleInboundSettle).not.toHaveBeenCalled();
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
    expect(redisMocks.scheduleInboundSettle).toHaveBeenCalledWith('+19785550198', expect.any(Number));
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

describe('internal numbers skip the customer pipeline', () => {
  it.each([
    ['Matt texting Ed from the business line', { direction: 'outgoing', from: '+16176681677', to: '+13392175091', body: 'Can we move our meeting to 2pm?' }, 'message.delivered'],
    ['Ed\'s line texting the business line', { direction: 'outgoing', from: '+13392175091', to: '+16176681677', body: 'can we see if theyre available between 1-2pm?' }, 'message.delivered'],
    ['Mike texting in', { direction: 'incoming', from: '+18573126761', to: '+16176681677', body: 'Running late, there by 10' }, 'message.received'],
  ])('%s: no PD lookup, no intake draft, no scheduling dispatch', async (_label, overrides, type) => {
    const evt = makeMessageEvent(overrides);
    (evt.object as { type: string }).type = type;
    const res = await POST(req(evt));
    expect(await res.json()).toMatchObject({ status: 'skipped', reason: 'internal_phone' });
    expect(redisMocks.getPipedriveIdFromPhone).not.toHaveBeenCalled();
    expect(redisMocks.scheduleIntakeDraft).not.toHaveBeenCalled();
    expect(redisMocks.scheduleInboundSettle).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('a customer message still reaches scheduling dispatch', async () => {
    await POST(req(makeMessageEvent()));
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  });
});
