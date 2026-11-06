/**
 * Unit tests for the per-concern modules behind api/webhooks/quo.ts
 * (lib/quo-webhook/*). The end-to-end ack-fast behavior lives in
 * webhooks-quo-ack-fast.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMocks = vi.hoisted(() => ({
  getPipedriveIdFromPhone: vi.fn(),
  storePhoneMapping: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
  enqueueQuoteTrigger: vi.fn().mockResolvedValue(undefined),
  readFieldCompletion: vi.fn(),
  trackWebhookProcessed: vi.fn(),
}));
vi.mock('../lib/redis.js', () => redisMocks);

const ensureInboundLeadDealMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/inbound-deal.js', () => ({ ensureInboundLeadDeal: ensureInboundLeadDealMock }));

const extractEntitiesMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(),
  getCalendar: vi.fn(),
  getDrive: vi.fn(),
  getGmail: vi.fn(),
  getGemini: vi.fn(() => ({ extractEntities: extractEntitiesMock })),
  getQuickBooks: vi.fn(),
  getQuo: vi.fn(),
}));

import { ExtractionError } from '@aac/api-clients/gemini';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuoEvent, QuoEventData } from '../lib/quo-webhook/types.js';
import {
  extractRemotePhone,
  extractTextForAI,
  shouldProcessForAI,
} from '../lib/quo-webhook/event-content.js';
import { buildDispatchContext } from '../lib/quo-webhook/scheduling.js';
import {
  logCallActivity,
  logQuoActivity,
  logSmsActivity,
  logTranscriptActivity,
} from '../lib/quo-webhook/activity.js';
import { findOrCreatePipedrivePerson } from '../lib/quo-webhook/pd-person.js';
import { extractAndApplyEntities } from '../lib/quo-webhook/entity-extraction.js';
import { enqueueQuoteTriggers, TECHNICIAN_PHONES } from '../lib/quo-webhook/quote-triggers.js';

const CUSTOMER = '+19785550199';
const LINE = '+16176681677';

function data(overrides: Partial<QuoEventData> = {}): QuoEventData {
  return {
    id: 'res-1',
    object: 'message',
    createdAt: '2026-10-21T15:00:00Z',
    direction: 'incoming',
    from: CUSTOMER,
    to: LINE,
    body: 'I have a crack in my basement wall',
    ...overrides,
  };
}

function event(type: QuoEvent['type'], d: QuoEventData = data()): QuoEvent {
  return {
    id: 'evt-1',
    type,
    createdAt: '2026-10-21T15:00:01Z',
    apiVersion: 'v3',
    data: { object: d },
  };
}

const transcript = data({
  object: 'callTranscript',
  direction: undefined,
  body: undefined,
  callId: 'call-9',
  dialogue: [
    { start: 0, end: 1, content: 'Attack A Crack, this is Matt', identifier: LINE, userId: 'U1' },
    { start: 1, end: 2, content: 'Hi, my basement leaks', identifier: CUSTOMER },
    { start: 2, end: 3, content: 'near the bulkhead', identifier: CUSTOMER },
  ],
});

function pdMock() {
  return {
    logActivity: vi.fn().mockResolvedValue(undefined),
    updatePersonIncremental: vi.fn().mockResolvedValue({ updated: true, fields: ['name'] }),
    searchPersonByPhone: vi.fn().mockResolvedValue(null),
    createPerson: vi.fn().mockResolvedValue({ id: 555 }),
  };
}
const asPd = (m: ReturnType<typeof pdMock>) => m as unknown as PipedriveClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('event-content', () => {
  it('reads the remote phone by direction for messages and calls', () => {
    expect(extractRemotePhone(data())).toBe(CUSTOMER);
    expect(extractRemotePhone(data({ direction: 'outgoing', from: LINE, to: CUSTOMER }))).toBe(CUSTOMER);
    expect(extractRemotePhone(data({ direction: 'incoming', from: undefined }))).toBeNull();
  });

  it('reads the remote phone from the first external transcript line', () => {
    expect(extractRemotePhone(transcript)).toBe(CUSTOMER);
    const internalOnly = data({
      object: 'callTranscript',
      dialogue: [{ start: 0, end: 1, content: 'x', identifier: LINE, userId: 'U1' }],
    });
    expect(extractRemotePhone(internalOnly)).toBeNull();
  });

  it('feeds the AI only the caller side of a transcript, the body for messages', () => {
    expect(extractTextForAI(transcript)).toBe('Hi, my basement leaks near the bulkhead');
    expect(extractTextForAI(data({ body: 'hello there' }))).toBe('hello there');
    expect(extractTextForAI(data({ body: undefined }))).toBe('');
  });

  it('skips extraction for outbound texts, calls, short text and AAC-only transcripts', () => {
    expect(shouldProcessForAI('message.delivered', data())).toBe(false);
    expect(shouldProcessForAI('call.completed', data())).toBe(false);
    expect(shouldProcessForAI('message.received', data({ body: 'ok thanks' }))).toBe(false);
    expect(shouldProcessForAI('message.received', data({ body: '0123456789' }))).toBe(true);
    expect(shouldProcessForAI('call.transcript.completed', transcript)).toBe(true);
    const aacOnly = data({
      object: 'callTranscript',
      dialogue: [{ start: 0, end: 1, content: 'leaving a long message here', identifier: LINE, userId: 'U1' }],
    });
    expect(shouldProcessForAI('call.transcript.completed', aacOnly)).toBe(false);
  });
});

describe('buildDispatchContext', () => {
  it('returns null for call events', () => {
    expect(buildDispatchContext(event('call.completed'), data(), CUSTOMER, 7)).toBeNull();
    expect(buildDispatchContext(event('call.ringing'), data(), CUSTOMER, 7)).toBeNull();
  });

  it('maps a message to text context (empty body becomes "")', () => {
    expect(buildDispatchContext(event('message.received'), data(), CUSTOMER, 7)).toEqual({
      eventId: 'evt-1',
      eventType: 'message.received',
      text: 'I have a crack in my basement wall',
      customerPhone: CUSTOMER,
      pdPersonId: 7,
    });
    expect(
      buildDispatchContext(event('message.delivered'), data({ body: undefined }), CUSTOMER, 7)?.text,
    ).toBe('');
  });

  it('maps transcript dialogue userId to isMatt; empty dialogue is null', () => {
    const ctx = buildDispatchContext(event('call.transcript.completed', transcript), transcript, CUSTOMER, 7);
    expect(ctx?.dialogue).toEqual([
      { content: 'Attack A Crack, this is Matt', isMatt: true },
      { content: 'Hi, my basement leaks', isMatt: false },
      { content: 'near the bulkhead', isMatt: false },
    ]);
    expect(ctx?.text).toBeUndefined();
    const empty = data({ object: 'callTranscript', dialogue: [] });
    expect(buildDispatchContext(event('call.transcript.completed', empty), empty, CUSTOMER, 7)).toBeNull();
  });
});

describe('activity', () => {
  it('logs an inbound call with line, duration, recording and voicemail', async () => {
    const pd = pdMock();
    await logCallActivity(
      asPd(pd),
      data({ object: 'call', duration: 125, recordingUrl: 'https://r', voicemailUrl: 'https://v' }),
      7,
    );
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'call', {
      subject: 'Inbound Call (2m 5s)',
      note: `Inbound call\nLine: ${LINE}\nDuration: 2m 5s\n\nRecording: https://r\n\nVoicemail: https://v`,
      duration: 125,
    });
  });

  it('falls back to answeredAt→createdAt for duration; outbound uses the from line', async () => {
    const pd = pdMock();
    await logCallActivity(
      asPd(pd),
      data({
        object: 'call',
        direction: 'outgoing',
        from: LINE,
        to: CUSTOMER,
        answeredAt: '2026-10-21T14:58:30Z',
        createdAt: '2026-10-21T15:00:00Z',
      }),
      7,
    );
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'call', {
      subject: 'Outbound Call (1m 30s)',
      note: `Outbound call\nLine: ${LINE}\nDuration: 1m 30s`,
      duration: 90,
    });
  });

  it('logs a zero-length call without a Duration line', async () => {
    const pd = pdMock();
    await logCallActivity(asPd(pd), data({ object: 'call', to: undefined }), 7);
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'call', {
      subject: 'Inbound Call (0m 0s)',
      note: 'Inbound call',
      duration: 0,
    });
  });

  it('logs SMS with a 100-char truncated subject and the handling line', async () => {
    const pd = pdMock();
    const long = 'x'.repeat(120);
    await logSmsActivity(asPd(pd), event('message.received'), data({ body: long }), 7);
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'sms', {
      subject: `SMS Received: "${'x'.repeat(100)}..."`,
      note: `Full message:\n\n${long}\n\nLine: ${LINE}`,
    });

    pd.logActivity.mockClear();
    await logSmsActivity(
      asPd(pd),
      event('message.delivered'),
      data({ body: undefined, direction: 'outgoing', from: LINE }),
      7,
    );
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'sms', {
      subject: 'SMS Sent: "(no content)"',
      note: `Full message:\n\n(no content)\n\nLine: ${LINE}`,
    });
  });

  it('logs transcripts with AAC/Caller speakers, or a placeholder', async () => {
    const pd = pdMock();
    await logTranscriptActivity(asPd(pd), transcript, 7);
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'call', {
      subject: 'Call Transcript Available',
      note: 'Transcript:\n\nAAC: Attack A Crack, this is Matt\nCaller: Hi, my basement leaks\nCaller: near the bulkhead',
    });
    pd.logActivity.mockClear();
    await logTranscriptActivity(asPd(pd), data({ object: 'callTranscript', dialogue: [] }), 7);
    expect(pd.logActivity).toHaveBeenCalledWith(7, 'call', {
      subject: 'Call Transcript Available',
      note: 'Transcript:\n\n(no transcript)',
    });
  });

  it('logQuoActivity routes by event type and ignores others', async () => {
    const pd = pdMock();
    await logQuoActivity(asPd(pd), event('message.received'), data(), 7);
    expect(pd.logActivity).toHaveBeenLastCalledWith(7, 'sms', expect.anything());
    await logQuoActivity(asPd(pd), event('call.transcript.completed', transcript), transcript, 7);
    expect(pd.logActivity.mock.calls[1][2].subject).toBe('Call Transcript Available');
    await logQuoActivity(asPd(pd), event('call.ringing'), data(), 7);
    expect(pd.logActivity).toHaveBeenCalledTimes(2);
  });
});

describe('findOrCreatePipedrivePerson', () => {
  it('uses the Redis cache first', async () => {
    redisMocks.getPipedriveIdFromPhone.mockResolvedValueOnce('42');
    const pd = pdMock();
    await expect(findOrCreatePipedrivePerson(asPd(pd), CUSTOMER)).resolves.toBe(42);
    expect(pd.searchPersonByPhone).not.toHaveBeenCalled();
  });

  it('falls back to a PD search and caches the hit', async () => {
    redisMocks.getPipedriveIdFromPhone.mockResolvedValueOnce(null);
    const pd = pdMock();
    pd.searchPersonByPhone.mockResolvedValueOnce({ id: 43 });
    await expect(findOrCreatePipedrivePerson(asPd(pd), CUSTOMER)).resolves.toBe(43);
    expect(redisMocks.storePhoneMapping).toHaveBeenCalledWith(CUSTOMER, '43');
    expect(pd.createPerson).not.toHaveBeenCalled();
  });

  it('creates an Unknown Lead plus its deal; a deal failure stays soft', async () => {
    redisMocks.getPipedriveIdFromPhone.mockResolvedValueOnce(null);
    ensureInboundLeadDealMock.mockRejectedValueOnce(new Error('pd 500'));
    const pd = pdMock();
    await expect(findOrCreatePipedrivePerson(asPd(pd), CUSTOMER)).resolves.toBe(555);
    expect(pd.createPerson).toHaveBeenCalledWith(`Unknown Lead ${CUSTOMER}`, CUSTOMER);
    expect(redisMocks.storePhoneMapping).toHaveBeenCalledWith(CUSTOMER, '555');
    expect(ensureInboundLeadDealMock).toHaveBeenCalledWith(pd, 555, CUSTOMER);
    expect(redisMocks.logHealthError).not.toHaveBeenCalled();
  });
});

describe('extractAndApplyEntities', () => {
  it('does nothing when the event does not qualify', async () => {
    const pd = pdMock();
    await extractAndApplyEntities(asPd(pd), event('message.delivered'), data(), 7, CUSTOMER);
    expect(extractEntitiesMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ fullName: 'Jane Q Doe', firstName: 'Jane', lastName: 'Doe' }, 'Jane Q Doe'],
    [{ firstName: 'Jane', lastName: 'Doe' }, 'Jane Doe'],
    [{ firstName: 'Jane' }, 'Jane'],
    [{ lastName: 'Doe' }, 'Doe'],
  ])('composes the name from %o', async (names, expected) => {
    extractEntitiesMock.mockResolvedValueOnce({
      fullName: null,
      firstName: null,
      lastName: null,
      email: 'jane@example.com',
      streetAddress: '1 Main St',
      city: 'Quincy',
      state: 'MA',
      zipCode: '02169',
      confidence: 0.9,
      ...names,
    });
    const pd = pdMock();
    await extractAndApplyEntities(asPd(pd), event('message.received'), data(), 7, CUSTOMER);
    expect(pd.updatePersonIncremental).toHaveBeenCalledWith(7, {
      name: expected,
      phone: CUSTOMER,
      email: 'jane@example.com',
      address: '1 Main St',
      city: 'Quincy',
      state: 'MA',
      zipCode: '02169',
    });
  });

  it('skips the PD write when nothing useful came back', async () => {
    extractEntitiesMock.mockResolvedValueOnce(null);
    const pd = pdMock();
    await extractAndApplyEntities(asPd(pd), event('message.received'), data(), 7, CUSTOMER);
    expect(pd.updatePersonIncremental).not.toHaveBeenCalled();
  });

  it('surfaces extraction failures to health with the reason, never throws', async () => {
    extractEntitiesMock.mockRejectedValueOnce(new ExtractionError('Gemini API error 500', 'api_error'));
    const pd = pdMock();
    await extractAndApplyEntities(asPd(pd), event('message.received'), data(), 7, CUSTOMER);
    expect(redisMocks.logHealthError).toHaveBeenCalledWith(
      'quo',
      'AI extraction failed (api_error): Gemini API error 500',
      { personId: '7', reason: 'api_error', eventType: 'message.received' },
    );
  });
});

describe('enqueueQuoteTriggers', () => {
  const TECH = [...TECHNICIAN_PHONES][0];

  it('enqueues messages with direction, media flag and a 300-char snippet', async () => {
    await enqueueQuoteTriggers(
      event('message.delivered'),
      data({ body: 'y'.repeat(400), media: [{ url: 'u', type: 'image/jpeg' }] }),
      CUSTOMER,
    );
    expect(redisMocks.enqueueQuoteTrigger).toHaveBeenCalledWith({
      phone: CUSTOMER,
      direction: 'outgoing',
      at: '2026-10-21T15:00:00Z',
      hasMedia: true,
      snippet: 'y'.repeat(300),
      kind: 'message',
    });
  });

  it('a technician transcript is a mike-debrief, a customer one a call-transcript', async () => {
    await enqueueQuoteTriggers(event('call.transcript.completed', transcript), transcript, TECH);
    expect(redisMocks.enqueueQuoteTrigger).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'mike-debrief', phone: TECH }),
    );
    await enqueueQuoteTriggers(event('call.transcript.completed', transcript), transcript, CUSTOMER);
    expect(redisMocks.enqueueQuoteTrigger).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'call-transcript', callId: 'call-9' }),
    );
    expect(redisMocks.enqueueQuoteTrigger).toHaveBeenCalledTimes(2);
  });

  it('a missed incoming call enqueues a voicemail probe; answered calls do not', async () => {
    const missed = data({ object: 'call', id: 'call-1' });
    await enqueueQuoteTriggers(event('call.completed', missed), missed, CUSTOMER);
    expect(redisMocks.enqueueQuoteTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'voicemail', callId: 'call-1' }),
    );
    redisMocks.enqueueQuoteTrigger.mockClear();
    const answered = data({ object: 'call', answeredAt: '2026-10-21T14:59:00Z' });
    await enqueueQuoteTriggers(event('call.completed', answered), answered, CUSTOMER);
    expect(redisMocks.enqueueQuoteTrigger).not.toHaveBeenCalled();
  });
});
