import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionError, type ClassifiedSchedulingIntent } from '@aac/api-clients/gemini';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

const {
  mockWritePendingDirective,
  mockLogHealthError,
  mockTrackSchedulingClassification,
  mockGetQbCustomerIdFromPipedrive,
  mockStorePipedriveToQbMapping,
} = vi.hoisted(() => ({
  mockWritePendingDirective: vi.fn(),
  mockLogHealthError: vi.fn(),
  mockTrackSchedulingClassification: vi.fn(),
  mockGetQbCustomerIdFromPipedrive: vi.fn().mockResolvedValue(null),
  mockStorePipedriveToQbMapping: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  writePendingDirective: mockWritePendingDirective,
  logHealthError: mockLogHealthError,
  trackSchedulingClassification: mockTrackSchedulingClassification,
  getQbCustomerIdFromPipedrive: mockGetQbCustomerIdFromPipedrive,
  storePipedriveToQbMapping: mockStorePipedriveToQbMapping,
  SCHEDULING_AUTO_PROPOSE_THRESHOLD: 0.7,
}));

import {
  dispatchSchedulingIntent,
  extractClassifierInputs,
  type SchedulingDispatchContext,
} from '../lib/scheduling-dispatch.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeClassification(
  overrides: Partial<ClassifiedSchedulingIntent> = {},
): ClassifiedSchedulingIntent {
  return {
    intent: null,
    score: 0,
    confidence: 'low',
    rationale: '',
    knownSlot: null,
    eventClass: null,
    slotCommitment: null,
    scopeSummary: '',
    ...overrides,
  };
}

function makeGemini(seq: Array<ClassifiedSchedulingIntent | Error>) {
  const fn = vi.fn();
  for (const r of seq) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return {
    classifySchedulingIntent: fn,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Returns a stub PD client. When `qbCustomerId` is passed, the underlying
 * raw person record carries the QB cross-system custom field so the
 * dispatch's `fetchPdPersonInfo` reads it out.
 */
function makePd(name: string | null, qbCustomerId?: string) {
  let person: PipedrivePerson | null = null;
  if (name !== null) {
    const raw: Record<string, unknown> = { id: 9001, name };
    if (qbCustomerId) {
      // Hash key for the QB customer cross-system field on PD persons.
      raw['a02e76a3d2d7e38cacd476aaea1c2a8809264025'] = qbCustomerId;
    }
    person = raw as unknown as PipedrivePerson;
  }
  return {
    getPerson: vi.fn().mockResolvedValue(person),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeCal(events: CalendarEvent[]) {
  return {
    listEvents: vi.fn().mockResolvedValue(events),
    createEvent: vi.fn().mockResolvedValue({
      id: 'evt-stub-1',
      htmlLink: 'https://calendar.google.com/event?id=evt-stub-1',
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeQuo(messages: Array<{ text: string; direction: string; createdAt: string }> = []) {
  return {
    listMessages: vi.fn().mockResolvedValue({ data: messages }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function ctxMsg(
  overrides: Partial<SchedulingDispatchContext> = {},
): SchedulingDispatchContext {
  return {
    eventId: 'evt-1',
    eventType: 'message.received',
    text: 'Let\'s do it! Lock it in.',
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    ...overrides,
  };
}

function ctxTranscript(dialogue: Array<{ content: string; isMatt: boolean }>) {
  return {
    eventId: 'evt-tx',
    eventType: 'call.transcript.completed' as const,
    dialogue,
    customerPhone: '+16175550123',
    pdPersonId: 9001,
  };
}

const fixedNow = () => new Date('2026-05-30T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

// ── extractClassifierInputs ───────────────────────────────────────

describe('extractClassifierInputs', () => {
  it('returns a customer input for message.received', () => {
    const out = extractClassifierInputs(ctxMsg());
    expect(out).toEqual([{ text: 'Let\'s do it! Lock it in.', speakerRole: 'customer' }]);
  });

  it('returns a matt input for message.delivered', () => {
    const out = extractClassifierInputs(ctxMsg({
      eventType: 'message.delivered',
      text: 'Tuesday at 10 works for me',
    }));
    expect(out).toEqual([{ text: 'Tuesday at 10 works for me', speakerRole: 'matt' }]);
  });

  it('skips when message text is below min length', () => {
    expect(extractClassifierInputs(ctxMsg({ text: 'ok' }))).toEqual([]);
  });

  it('returns both customer and matt inputs from transcript dialogue', () => {
    const out = extractClassifierInputs(ctxTranscript([
      { content: 'I want to move forward with the quote', isMatt: false },
      { content: 'Sounds good. Tuesday at 10 work for you?', isMatt: true },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      text: 'I want to move forward with the quote',
      speakerRole: 'customer',
    });
    expect(out[1]).toEqual({
      text: 'Sounds good. Tuesday at 10 work for you?',
      speakerRole: 'matt',
    });
  });

  it('omits speaker whose dialogue is below the length floor', () => {
    const out = extractClassifierInputs(ctxTranscript([
      { content: 'yeah ok', isMatt: false }, // too short
      { content: 'Let me get you on the books Wednesday morning', isMatt: true },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].speakerRole).toBe('matt');
  });
});

// ── dispatchSchedulingIntent ──────────────────────────────────────

describe('dispatchSchedulingIntent', () => {
  it('writes a QuoteApprovedDirective for an accepting customer text', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'quote_approved',
        score: 0.9,
        confidence: 'high',
        rationale: 'customer accepted',
      }),
    ]);
    const pd = makePd('John Smith');
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      { pd, cal, gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg(),
    );

    expect(summary.classified).toBe(1);
    expect(summary.intentsDetected).toBe(1);
    expect(summary.directivesWritten).toBe(1);
    expect(mockWritePendingDirective).toHaveBeenCalledTimes(1);
    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.intent).toBe('quote_approved');
    expect(written.source).toBe('quo_text');
    expect(written.pdPersonId).toBe(9001);
  });

  it('writes an AssessmentRequestedDirective from an inbound inquiry', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'assessment_requested', score: 0.75, confidence: 'medium',
        rationale: 'site visit asked', scopeSummary: 'wet basement',
      }),
    ]);
    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Jane Smith'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'Can you come look at my basement?' }),
    );

    expect(summary.directivesWritten).toBe(1);
    expect(mockWritePendingDirective.mock.calls[0][0].intent).toBe('assessment_requested');
  });

  it('writes a CallbackOpenedDirective when calendar resolves a parent', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'callback_opened', score: 0.85, confidence: 'high',
        rationale: 'prior fix leaking', scopeSummary: 'crack reopening',
      }),
    ]);
    const pd = makePd('John Smith');
    const cal = makeCal([
      {
        id: 'parent', summary: 'John Smith — Crack Injection',
        description: '[deal:42] Smith basement', start: '2025-09-01T13:00:00Z',
        end: '2025-09-01T15:00:00Z', colorId: '10',
        attendees: [], htmlLink: '', attachments: [],
      },
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd, cal, gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'The crack you fixed is leaking again' }),
    );

    expect(summary.directivesWritten).toBe(1);
    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.intent).toBe('callback_opened');
    expect(written.parentDealId).toBe(42);
    expect(written.callbackSequence).toBe(1);
    expect(written.originalServiceType).toBe('Crack Injection');
  });

  it('skips callback when parent deal cannot be resolved (soft failure — does NOT page Matt)', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'callback_opened', score: 0.85, confidence: 'high',
        rationale: 'prior fix leaking', scopeSummary: '',
      }),
    ]);
    const summary = await dispatchSchedulingIntent(
      {
        pd: makePd('Solo Customer'),
        cal: makeCal([]), // no events match
        gemini,
        quo: makeQuo(),
        now: fixedNow,
      },
      ctxMsg({ text: 'My old crack repair is leaking again' }),
    );

    expect(summary.directivesWritten).toBe(0);
    expect(summary.callbackParentMisses).toBe(1);
    expect(mockWritePendingDirective).not.toHaveBeenCalled();
    // Soft failure — business outcome, not system error. The error-surface
    // SMS channel is reserved for real failures.
    expect(mockLogHealthError).not.toHaveBeenCalled();
  });

  it('writes a ManualScheduleDirective from Matt outbound', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'manual_schedule', score: 0.9, confidence: 'high',
        rationale: 'time named', scopeSummary: 'crack injection',
        knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
      }),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('John Smith'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({
        eventType: 'message.delivered',
        text: 'Lock you in for Tuesday at 10',
      }),
    );

    expect(summary.directivesWritten).toBe(1);
    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.intent).toBe('manual_schedule');
    expect(written.knownSlot).toEqual({ startIso: '2026-06-02T14:00:00Z' });
  });

  it('does nothing when classifier returns null intent', async () => {
    const gemini = makeGemini([makeClassification({ intent: null })]);
    const summary = await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'thanks for the info!' }),
    );

    expect(summary.classified).toBe(1);
    expect(summary.intentsDetected).toBe(0);
    expect(summary.directivesWritten).toBe(0);
    expect(mockWritePendingDirective).not.toHaveBeenCalled();
  });

  it('runs both customer and matt classifications on transcripts', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'quote_approved', score: 0.85, confidence: 'high',
        rationale: 'accepted in call',
      }),
      makeClassification({
        intent: 'manual_schedule', score: 0.9, confidence: 'high',
        rationale: 'named a time', knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
      }),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Caller Customer'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxTranscript([
        { content: 'Yes, we want to move forward with the quote', isMatt: false },
        { content: 'Great, locking you in Tuesday at 10', isMatt: true },
      ]),
    );

    expect(summary.classified).toBe(2);
    expect(summary.intentsDetected).toBe(2);
    expect(summary.directivesWritten).toBe(2);
    const intents = mockWritePendingDirective.mock.calls.map((c) => c[0].intent);
    expect(intents).toContain('quote_approved');
    expect(intents).toContain('manual_schedule');
  });

  it('continues processing when one classifier call rejects', async () => {
    const gemini = makeGemini([
      new Error('gemini down'),
      makeClassification({
        intent: 'manual_schedule', score: 0.9, confidence: 'high',
        rationale: 'time named', knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
      }),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Caller'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxTranscript([
        { content: 'Some longer customer-side dialogue here', isMatt: false },
        { content: 'Some longer matt-side dialogue with a time in it Tuesday 10', isMatt: true },
      ]),
    );

    expect(summary.errors).toBe(1);
    expect(summary.directivesWritten).toBe(1);
    // Soft failure — classifier degraded gracefully (no directive for that
    // input). Logged at error level for observability but NOT routed to the
    // error-surface SMS channel (which is reserved for real system failures).
    expect(mockLogHealthError).not.toHaveBeenCalled();
  });

  it('surfaces classifier api_error to health:errors (dead model / broken config)', async () => {
    const gemini = makeGemini([
      new ExtractionError('Gemini API error 404: model retired', 'api_error'),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Caller'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'Can you come out and look at my basement please?' }),
    );

    expect(summary.errors).toBe(1);
    expect(mockLogHealthError).toHaveBeenCalledTimes(1);
    expect(mockLogHealthError).toHaveBeenCalledWith(
      'scheduling-dispatch',
      expect.stringContaining('api_error'),
      expect.any(Object),
    );
  });

  it('does NOT surface transient/parse classifier failures to health:errors', async () => {
    const gemini = makeGemini([
      new ExtractionError('JSON parse failed: garbage', 'parse_error'),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Caller'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'Can you come out and look at my basement please?' }),
    );

    expect(summary.errors).toBe(1);
    expect(mockLogHealthError).not.toHaveBeenCalled();
  });

  it('returns empty summary when no inputs pass the gate', async () => {
    const gemini = { classifySchedulingIntent: vi.fn() };

    const summary = await dispatchSchedulingIntent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pd: makePd('X'), cal: makeCal([]), gemini: gemini as any, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'ok' }),
    );

    expect(summary.classified).toBe(0);
    expect(gemini.classifySchedulingIntent).not.toHaveBeenCalled();
    expect(mockTrackSchedulingClassification).not.toHaveBeenCalled();
  });

  it('tracks the run via trackSchedulingClassification when work happened', async () => {
    const gemini = makeGemini([
      makeClassification({ intent: 'quote_approved', score: 0.9, confidence: 'high' }),
    ]);

    await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg(),
    );

    expect(mockTrackSchedulingClassification).toHaveBeenCalledWith(
      'message.received',
      expect.objectContaining({ classified: 1, directivesWritten: 1 }),
    );
  });

  // ── qbCustomerId resolution (Walk #6.5 follow-up) ──────────────

  it('propagates qbCustomerId onto the directive when PD person has the QB cross-system field set', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'quote_approved',
        score: 0.9,
        confidence: 'high',
        rationale: 'customer accepted',
      }),
    ]);
    const pd = makePd('Margie Mercadante', 'qb-cust-42');
    mockGetQbCustomerIdFromPipedrive.mockResolvedValueOnce(null);

    await dispatchSchedulingIntent(
      { pd, cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ pdPersonId: 5590 }),
    );

    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.qbCustomerId).toBe('qb-cust-42');
    // Cache should be warmed once we read PD's custom field.
    expect(mockStorePipedriveToQbMapping).toHaveBeenCalledWith('5590', 'qb-cust-42');
  });

  it('uses the Redis PD→QB cache hit and skips the PD custom-field read', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'assessment_requested',
        score: 0.85,
        confidence: 'high',
        rationale: 'wants visit',
      }),
    ]);
    const pd = makePd('Cached Customer'); // no field on PD raw record
    mockGetQbCustomerIdFromPipedrive.mockResolvedValueOnce('qb-cached-7');

    await dispatchSchedulingIntent(
      { pd, cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ pdPersonId: 7777 }),
    );

    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.qbCustomerId).toBe('qb-cached-7');
    expect(mockStorePipedriveToQbMapping).not.toHaveBeenCalled();
  });

  it('omits qbCustomerId from the directive when neither cache nor PD has one', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'quote_approved',
        score: 0.9,
        confidence: 'high',
        rationale: 'accepted',
      }),
    ]);
    const pd = makePd('Unlinked Customer');
    mockGetQbCustomerIdFromPipedrive.mockResolvedValueOnce(null);

    await dispatchSchedulingIntent(
      { pd, cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ pdPersonId: 5555 }),
    );

    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.qbCustomerId).toBeUndefined();
    expect(mockStorePipedriveToQbMapping).not.toHaveBeenCalled();
  });

  // ── appointment_confirmed + conversation context (Walk #7-lite) ──

  it('writes an AppointmentConfirmedDirective when the customer confirms an offered slot', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        rationale: 'accepted the Monday slot',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
      }),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Margie Mercadante'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.directivesWritten).toBe(1);
    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.intent).toBe('appointment_confirmed');
    expect(written.eventClass).toBe('assessment');
    expect(written.knownSlot).toEqual({ startIso: '2026-06-08T15:30:00Z' });
  });

  it('drops appointment_confirmed when no slot could be resolved', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: null,
      }),
    ]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo: makeQuo(), now: fixedNow },
      ctxMsg({ text: 'Yes that sounds good to me' }),
    );

    expect(summary.directivesWritten).toBe(0);
    expect(mockWritePendingDirective).not.toHaveBeenCalled();
  });

  it('feeds recent Quo messages to the classifier as conversation context', async () => {
    const gemini = makeGemini([makeClassification({ intent: null })]);
    const quo = makeQuo([
      { text: 'Would Tuesday at 10 work?', direction: 'outgoing', createdAt: '2026-05-30T11:58:00Z' },
      { text: 'Let\'s do it! Lock it in.', direction: 'incoming', createdAt: '2026-05-30T11:59:00Z' },
    ]);

    await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo, now: fixedNow },
      ctxMsg(), // text matches the newest row → excluded from context
    );

    const opts = gemini.classifySchedulingIntent.mock.calls[0][1];
    expect(opts.conversationContext).toBe('MATT: Would Tuesday at 10 work?');
  });

  it('classifies without context when the Quo history fetch fails', async () => {
    const gemini = makeGemini([makeClassification({ intent: null })]);
    const quo = {
      listMessages: vi.fn().mockRejectedValue(new Error('quo down')),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo, now: fixedNow },
      ctxMsg(),
    );

    expect(summary.classified).toBe(1);
    const opts = gemini.classifySchedulingIntent.mock.calls[0][1];
    expect(opts.conversationContext).toBeUndefined();
  });

  it('uses the transcript dialogue itself as context without calling Quo', async () => {
    const gemini = makeGemini([
      makeClassification({ intent: null }),
      makeClassification({ intent: null }),
    ]);
    const quo = makeQuo();

    await dispatchSchedulingIntent(
      { pd: makePd('X'), cal: makeCal([]), gemini, quo, now: fixedNow },
      ctxTranscript([
        { content: 'I want to move forward with the quote', isMatt: false },
        { content: 'Sounds good. Tuesday at 10 work for you?', isMatt: true },
      ]),
    );

    expect(quo.listMessages).not.toHaveBeenCalled();
    const opts = gemini.classifySchedulingIntent.mock.calls[0][1];
    expect(opts.conversationContext).toBe(
      'CUSTOMER: I want to move forward with the quote\nMATT: Sounds good. Tuesday at 10 work for you?',
    );
  });

  // ── stub-event execution ─────────────────────────────────────────

  const stubOn = { enabled: true, technicianEmails: ['mike@attackacrack.com'] };

  it('creates a STUB event for a booked manual schedule above the confidence gate', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'manual_schedule',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
        slotCommitment: 'booked',
        scopeSummary: 'crack injection',
      }),
    ]);
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('John Smith'), cal, gemini, quo: makeQuo(), stub: stubOn, now: fixedNow },
      ctxMsg({ eventType: 'message.delivered', text: "I'm putting you down for Tuesday at 10" }),
    );

    expect(summary.directivesWritten).toBe(1);
    expect(summary.stubsCreated).toBe(1);
    expect(cal.createEvent).toHaveBeenCalledTimes(1);
    const evt = cal.createEvent.mock.calls[0][0];
    expect(evt.summary).toBe('STUB — John Smith');
    expect(evt.colorId).toBe('10');
    expect(evt.sendUpdates).toBe('none');
    expect(evt.attendees).toEqual(['mike@attackacrack.com']);
  });

  it('does NOT create a stub for an offered slot (waiting on the customer)', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'manual_schedule',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
        slotCommitment: 'offered',
      }),
    ]);
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('John Smith'), cal, gemini, quo: makeQuo(), stub: stubOn, now: fixedNow },
      ctxMsg({ eventType: 'message.delivered', text: 'Would Tuesday at 10 work for you?' }),
    );

    expect(summary.directivesWritten).toBe(1);
    expect(summary.stubsCreated).toBe(0);
    expect(cal.createEvent).not.toHaveBeenCalled();
  });

  it('creates a stub when the customer confirms an offered slot', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
      }),
    ]);
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Margie Mercadante'), cal, gemini, quo: makeQuo(), stub: stubOn, now: fixedNow },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.stubsCreated).toBe(1);
    const evt = cal.createEvent.mock.calls[0][0];
    expect(evt.summary).toBe('STUB — Margie Mercadante');
    expect(evt.colorId).toBe('3');
    // assessment stub = 30 minutes
    const durMin = (new Date(evt.end).getTime() - new Date(evt.start).getTime()) / 60000;
    expect(durMin).toBe(30);
  });

  it('does not create stubs when the flag is off', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
      }),
    ]);
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      {
        pd: makePd('Margie Mercadante'),
        cal,
        gemini,
        quo: makeQuo(),
        stub: { enabled: false, technicianEmails: [] },
        now: fixedNow,
      },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.directivesWritten).toBe(1); // shadow queue still gets it
    expect(summary.stubsCreated).toBe(0);
    expect(cal.createEvent).not.toHaveBeenCalled();
  });

  it('writes a Matt-voice description and attaches customer photos when drive is configured', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
        scopeSummary: 'wet basement NE corner',
      }),
    ]);
    gemini.generateContent = vi
      .fn()
      .mockResolvedValue('NOTE: call ahead.\n\nWet basement in the NE corner, go have a look.\n\nSee attached photos.');
    const quo = makeQuo([
      {
        text: 'Here are the photos',
        direction: 'incoming',
        createdAt: '2026-05-29T12:00:00Z',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        media: [{ url: 'https://share.quo.com/v1/resource/message-media/abc.jpg?sig=x', type: 'image/jpeg' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
    quo.downloadMessageMedia = vi
      .fn()
      .mockResolvedValue({ data: new ArrayBuffer(1), contentType: 'image/jpeg' });
    const drive = {
      ensureFolder: vi.fn().mockResolvedValue('FOLD'),
      uploadFile: vi.fn().mockResolvedValue({ id: 'f1', fileUrl: 'https://drive.google.com/open?id=f1' }),
      shareWithUsers: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      {
        pd: makePd('Margie Mercadante'),
        cal,
        gemini,
        quo,
        stub: { ...stubOn, drive },
        now: fixedNow,
      },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.stubsCreated).toBe(1);
    const evt = cal.createEvent.mock.calls[0][0];
    expect(evt.description).toContain('NOTE: call ahead.');
    expect(evt.description).toContain('go have a look');
    // provenance footer survives the rich description
    expect(evt.description).toContain('Auto-created stub');
    expect(evt.attachments).toEqual([
      { fileUrl: 'https://drive.google.com/open?id=f1', title: 'abc.jpg', mimeType: 'image/jpeg' },
    ]);
    expect(drive.shareWithUsers).toHaveBeenCalledWith('f1', ['mike@attackacrack.com']);
  });

  it('a photo-pipeline failure still creates the stub without attachments', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
        scopeSummary: 'wet basement NE corner',
      }),
    ]);
    gemini.generateContent = vi.fn().mockResolvedValue('Wet basement in the NE corner, go have a look.');
    const quo = makeQuo([
      {
        text: 'Here are the photos',
        direction: 'incoming',
        createdAt: '2026-05-29T12:00:00Z',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        media: [{ url: 'https://share.quo.com/v1/resource/message-media/abc.jpg?sig=x', type: 'image/jpeg' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
    const drive = {
      ensureFolder: vi.fn().mockRejectedValue(new Error('insufficient scopes')),
      uploadFile: vi.fn(),
      shareWithUsers: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const cal = makeCal([]);

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Margie Mercadante'), cal, gemini, quo, stub: { ...stubOn, drive }, now: fixedNow },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.stubsCreated).toBe(1);
    const evt = cal.createEvent.mock.calls[0][0];
    expect(evt.attachments).toBeUndefined();
    expect(evt.description).toContain('go have a look');
  });

  it('a stub-creation failure surfaces to health but keeps the directive', async () => {
    const gemini = makeGemini([
      makeClassification({
        intent: 'appointment_confirmed',
        score: 0.9,
        confidence: 'high',
        knownSlot: { startIso: '2026-06-08T15:30:00Z' },
        eventClass: 'assessment',
      }),
    ]);
    const cal = makeCal([]);
    cal.createEvent.mockRejectedValue(new Error('calendar 500'));

    const summary = await dispatchSchedulingIntent(
      { pd: makePd('Margie Mercadante'), cal, gemini, quo: makeQuo(), stub: stubOn, now: fixedNow },
      ctxMsg({ text: 'Yes. That will work. Thank you.' }),
    );

    expect(summary.directivesWritten).toBe(1);
    expect(summary.stubsCreated).toBe(0);
    expect(summary.errors).toBe(0); // stub failures are soft
    expect(mockLogHealthError).toHaveBeenCalledWith(
      'scheduling-dispatch',
      expect.stringContaining('Stub creation failed'),
      expect.anything(),
    );
  });
});
