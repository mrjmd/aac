import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifiedSchedulingIntent } from '@aac/api-clients/gemini';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

const {
  mockWritePendingDirective,
  mockLogHealthError,
  mockTrackSchedulingClassification,
} = vi.hoisted(() => ({
  mockWritePendingDirective: vi.fn(),
  mockLogHealthError: vi.fn(),
  mockTrackSchedulingClassification: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  writePendingDirective: mockWritePendingDirective,
  logHealthError: mockLogHealthError,
  trackSchedulingClassification: mockTrackSchedulingClassification,
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

function makePd(name: string | null) {
  return {
    getPerson: vi.fn().mockResolvedValue(
      name === null ? null : ({ id: 9001, name } as PipedrivePerson),
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeCal(events: CalendarEvent[]) {
  return {
    listEvents: vi.fn().mockResolvedValue(events),
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
      { pd, cal, gemini, now: fixedNow },
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
      { pd: makePd('Jane Smith'), cal: makeCal([]), gemini, now: fixedNow },
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
      { pd, cal, gemini, now: fixedNow },
      ctxMsg({ text: 'The crack you fixed is leaking again' }),
    );

    expect(summary.directivesWritten).toBe(1);
    const written = mockWritePendingDirective.mock.calls[0][0];
    expect(written.intent).toBe('callback_opened');
    expect(written.parentDealId).toBe(42);
    expect(written.callbackSequence).toBe(1);
    expect(written.originalServiceType).toBe('Crack Injection');
  });

  it('skips callback when parent deal cannot be resolved and logs health error', async () => {
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
        now: fixedNow,
      },
      ctxMsg({ text: 'My old crack repair is leaking again' }),
    );

    expect(summary.directivesWritten).toBe(0);
    expect(summary.callbackParentMisses).toBe(1);
    expect(mockWritePendingDirective).not.toHaveBeenCalled();
    expect(mockLogHealthError).toHaveBeenCalledWith(
      'quo',
      'Callback intent detected but parent deal could not be resolved',
      expect.objectContaining({ eventId: 'evt-1' }),
    );
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
      { pd: makePd('John Smith'), cal: makeCal([]), gemini, now: fixedNow },
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
      { pd: makePd('X'), cal: makeCal([]), gemini, now: fixedNow },
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
      { pd: makePd('Caller Customer'), cal: makeCal([]), gemini, now: fixedNow },
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
      { pd: makePd('Caller'), cal: makeCal([]), gemini, now: fixedNow },
      ctxTranscript([
        { content: 'Some longer customer-side dialogue here', isMatt: false },
        { content: 'Some longer matt-side dialogue with a time in it Tuesday 10', isMatt: true },
      ]),
    );

    expect(summary.errors).toBe(1);
    expect(summary.directivesWritten).toBe(1);
    expect(mockLogHealthError).toHaveBeenCalledWith(
      'quo',
      expect.stringContaining('Scheduling classifier failed'),
      expect.objectContaining({ eventId: 'evt-tx' }),
    );
  });

  it('returns empty summary when no inputs pass the gate', async () => {
    const gemini = { classifySchedulingIntent: vi.fn() };

    const summary = await dispatchSchedulingIntent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pd: makePd('X'), cal: makeCal([]), gemini: gemini as any, now: fixedNow },
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
      { pd: makePd('X'), cal: makeCal([]), gemini, now: fixedNow },
      ctxMsg(),
    );

    expect(mockTrackSchedulingClassification).toHaveBeenCalledWith(
      'message.received',
      expect.objectContaining({ classified: 1, directivesWritten: 1 }),
    );
  });
});
