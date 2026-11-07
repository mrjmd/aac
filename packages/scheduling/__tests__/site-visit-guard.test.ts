/**
 * Site-visit guard: a manual_schedule for a contact with no address, no QB
 * quote and no history goes to pending-review, never to a STUB or HOLD.
 *
 * Incident: Paul Sullivan, a Sports Hub radio ad salesperson, 2026-11-06.
 * Matt agreed to a phone call Monday at 9; the classifier returned a booked
 * manual_schedule and the dispatch made an assessment STUB with Mike
 * invited. The fixture holds the real call transcript, PD person, QB and
 * Quo state read at the time.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifiedSchedulingIntent } from '@aac/api-clients/gemini';
import {
  dispatchSchedulingIntent,
  findSiteVisitEvidence,
  NO_SITE_VISIT_EVIDENCE_SCORE_CAP,
  type SchedulingDispatchContext,
  type SchedulingDispatchDeps,
} from '../src/dispatch.js';
import { SCHEDULING_AUTO_PROPOSE_THRESHOLD } from '../src/constants.js';
import type { SchedulingDirective } from '../src/types.js';

interface Fixture {
  now: string;
  context: SchedulingDispatchContext;
  pdPerson: { id: number; name: string; address: string | null; qbCustomerId: string | null };
  qb: { estimates: Array<Record<string, unknown>>; invoices: Array<Record<string, unknown>> };
  quoMessages: Array<{ direction: string; createdAt: string; text: string }>;
  incidentClassification: {
    matt: ClassifiedSchedulingIntent;
    customer: ClassifiedSchedulingIntent;
  };
  incidentDirective: { id: string; confidence: { score: number; signals: string[] } };
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/paul-sullivan-2026-11-06.json', import.meta.url), 'utf8'),
) as Fixture;

// PD custom-field hashes (PIPEDRIVE_CROSS_SYSTEM_FIELDS).
const QB_FIELD = 'a02e76a3d2d7e38cacd476aaea1c2a8809264025';
const ADDRESS_FIELD = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';

const stubOn = { enabled: true, technicianEmails: ['mike@attackacrack.com'] };
const holdsOn = { enabled: true };

function makeStore() {
  return {
    writePendingDirective: vi.fn(),
    logHealthError: vi.fn(),
    trackSchedulingClassification: vi.fn(),
    getQbCustomerIdFromPipedrive: vi.fn().mockResolvedValue(null),
    getDirectiveIdByEstimate: vi.fn().mockResolvedValue(null),
    storePipedriveToQbMapping: vi.fn(),
    countCondition: vi.fn(),
  };
}

function makePd(person: { name: string; address: string | null; qbCustomerId: string | null }) {
  const raw: Record<string, unknown> = { id: 9001, name: person.name };
  if (person.address) raw[ADDRESS_FIELD] = person.address;
  if (person.qbCustomerId) raw[QB_FIELD] = person.qbCustomerId;
  return { getPerson: vi.fn().mockResolvedValue(raw) };
}

function makeQb(opts: {
  estimates?: Array<Record<string, unknown>>;
  invoices?: Array<Record<string, unknown>>;
  connected?: boolean;
  throws?: boolean;
} = {}) {
  const estimates = opts.throws
    ? vi.fn().mockRejectedValue(new Error('QB 500'))
    : vi.fn().mockResolvedValue(opts.estimates ?? []);
  return {
    isConnected: vi.fn().mockResolvedValue(opts.connected ?? true),
    getEstimatesByCustomer: estimates,
    getInvoicesByCustomer: vi.fn().mockResolvedValue(opts.invoices ?? []),
  };
}

function makeQuo(messages: Array<{ direction: string; createdAt: string; text: string }>) {
  return { listMessages: vi.fn().mockResolvedValue({ data: messages }) };
}

function makeCal() {
  return {
    listEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ id: 'evt-1', htmlLink: 'https://cal/evt-1' }),
    updateEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
  };
}

function makeGemini(results: ClassifiedSchedulingIntent[]) {
  const fn = vi.fn();
  for (const r of results) fn.mockResolvedValueOnce(r);
  // The rest of the stub path (description builder) is fail-soft.
  fn.mockResolvedValue(null);
  return { classifySchedulingIntent: fn, generateContent: vi.fn().mockRejectedValue(new Error('off')) };
}

function bookedJob(): ClassifiedSchedulingIntent {
  return {
    intent: 'manual_schedule',
    score: 0.9,
    confidence: 'high',
    rationale: '',
    knownSlot: { startIso: '2026-06-02T14:00:00Z' },
    eventClass: 'job',
    slotCommitment: 'booked',
    scopeSummary: 'crack injection',
  };
}

const textCtx: SchedulingDispatchContext = {
  eventId: 'evt-text',
  eventType: 'message.delivered',
  text: "I'm putting you down for Tuesday at 10",
  customerPhone: '+16175550123',
  pdPersonId: 9001,
};

type Parts = {
  pd: ReturnType<typeof makePd>;
  qb?: ReturnType<typeof makeQb>;
  quo: ReturnType<typeof makeQuo>;
  cal: ReturnType<typeof makeCal>;
  gemini: ReturnType<typeof makeGemini>;
  store: ReturnType<typeof makeStore>;
  now: Date;
};

function deps(p: Parts): SchedulingDispatchDeps {
  return {
    store: p.store,
    pd: p.pd,
    cal: p.cal,
    gemini: p.gemini,
    quo: p.quo,
    ...(p.qb ? { qb: p.qb } : {}),
    stub: stubOn,
    holds: holdsOn,
    now: () => p.now,
  } as unknown as SchedulingDispatchDeps;
}

function written(store: ReturnType<typeof makeStore>): SchedulingDirective {
  return store.writePendingDirective.mock.calls[0][0] as SchedulingDirective;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('site-visit guard: Paul Sullivan fixture (real inputs, 2026-11-06)', () => {
  function sullivanParts(classifications: ClassifiedSchedulingIntent[]): Parts {
    return {
      pd: makePd(fixture.pdPerson),
      qb: makeQb({ estimates: fixture.qb.estimates, invoices: fixture.qb.invoices }),
      quo: makeQuo(fixture.quoMessages),
      cal: makeCal(),
      gemini: makeGemini(classifications),
      store: makeStore(),
      now: new Date(fixture.now),
    };
  }

  it('the incident classification no longer makes a STUB: it goes to pending-review', async () => {
    // Transcript order: customer side first, Matt side second.
    const p = sullivanParts([
      fixture.incidentClassification.customer,
      fixture.incidentClassification.matt,
    ]);

    const summary = await dispatchSchedulingIntent(deps(p), fixture.context);

    expect(summary.directivesWritten).toBe(1);
    expect(summary.sentToReview).toBe(1);
    expect(summary.stubsCreated).toBe(0);
    expect(summary.holdsCreated).toBe(0);
    expect(p.cal.createEvent).not.toHaveBeenCalled();

    const d = written(p.store);
    expect(d.intent).toBe('manual_schedule');
    expect(d.confidence.score).toBe(NO_SITE_VISIT_EVIDENCE_SCORE_CAP);
    expect(d.confidence.score).toBeLessThan(SCHEDULING_AUTO_PROPOSE_THRESHOLD);
    expect(d.confidence.signals).toContain('no_site_visit_evidence');
    // The incident directive scored above the gate; that is what made the stub.
    expect(fixture.incidentDirective.confidence.score).toBeGreaterThanOrEqual(
      SCHEDULING_AUTO_PROPOSE_THRESHOLD,
    );
  });

  it('a null classification (the new prompt rule) writes nothing at all', async () => {
    const p = sullivanParts([
      fixture.incidentClassification.customer,
      { ...fixture.incidentClassification.customer },
    ]);

    const summary = await dispatchSchedulingIntent(deps(p), fixture.context);

    expect(summary.intentsDetected).toBe(0);
    expect(p.store.writePendingDirective).not.toHaveBeenCalled();
    expect(p.cal.createEvent).not.toHaveBeenCalled();
  });

  it('checked every evidence source before concluding none', async () => {
    const p = sullivanParts([]);
    const result = await findSiteVisitEvidence(deps(p), fixture.context);
    expect(result).toBe('none');
    expect(p.quo.listMessages).toHaveBeenCalled();
    expect(p.qb!.getEstimatesByCustomer).toHaveBeenCalledWith('2239');
    expect(p.qb!.getInvoicesByCustomer).toHaveBeenCalledWith('2239');
  });
});

describe('site-visit guard: routing', () => {
  function parts(over: Partial<Parts> = {}): Parts {
    return {
      pd: makePd({ name: 'John Smith', address: null, qbCustomerId: 'qb-1' }),
      qb: makeQb(),
      quo: makeQuo([]),
      cal: makeCal(),
      gemini: makeGemini([bookedJob()]),
      store: makeStore(),
      now: new Date('2026-05-30T12:00:00Z'),
      ...over,
    };
  }

  it('no address, no estimate, no history: pending-review, no stub', async () => {
    const p = parts();
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(1);
    expect(summary.stubsCreated).toBe(0);
    expect(p.cal.createEvent).not.toHaveBeenCalled();
    expect(written(p.store).confidence.score).toBeLessThan(SCHEDULING_AUTO_PROPOSE_THRESHOLD);
  });

  it('no QB customer link and no texts: pending-review', async () => {
    const p = parts({ pd: makePd({ name: 'Rob', address: null, qbCustomerId: null }) });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(1);
    expect(p.qb!.getEstimatesByCustomer).not.toHaveBeenCalled();
  });

  it('an offered slot with no evidence gets no HOLD either', async () => {
    const p = parts({ gemini: makeGemini([{ ...bookedJob(), slotCommitment: 'offered' }]) });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(1);
    expect(summary.holdsCreated).toBe(0);
    expect(p.cal.createEvent).not.toHaveBeenCalled();
  });

  it('a normal customer booking (address on file) still makes the STUB', async () => {
    const p = parts({
      pd: makePd({ name: 'John Smith', address: '12 Main St, Quincy, MA', qbCustomerId: 'qb-1' }),
    });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
    expect(p.cal.createEvent.mock.calls[0][0].summary).toBe('STUB — John Smith');
    expect(p.cal.createEvent.mock.calls[0][0].attendees).toEqual(['mike@attackacrack.com']);
    expect(written(p.store).confidence.signals).not.toContain('no_site_visit_evidence');
    // Address alone settles it: no guard Quo lookup (maxResults 50), no QB.
    const quoLimits = p.quo.listMessages.mock.calls.map(
      (c: unknown[]) => (c[0] as { maxResults: number }).maxResults,
    );
    expect(quoLimits).not.toContain(50);
    expect(p.qb!.isConnected).not.toHaveBeenCalled();
  });

  it('a contact who has texted us counts as history (lead with no address yet)', async () => {
    const p = parts({
      quo: makeQuo([{ direction: 'incoming', createdAt: '2026-05-29T12:00:00Z', text: 'crack photos' }]),
    });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
  });

  it('a QB estimate counts', async () => {
    const p = parts({ qb: makeQb({ estimates: [{ Id: 'e1' }] }) });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
  });

  it('a QB invoice counts', async () => {
    const p = parts({ qb: makeQb({ invoices: [{ Id: 'i1' }] }) });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
  });

  it('fails open when a lookup throws (pre-guard behavior)', async () => {
    const p = parts({ qb: makeQb({ throws: true }) });
    const summary = await dispatchSchedulingIntent(deps(p), textCtx);
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
  });

  it('fails open when QB is disconnected or not wired', async () => {
    const disconnected = parts({ qb: makeQb({ connected: false }) });
    expect((await dispatchSchedulingIntent(deps(disconnected), textCtx)).stubsCreated).toBe(1);

    const unwired = parts({ qb: undefined });
    delete unwired.qb;
    expect((await dispatchSchedulingIntent(deps(unwired), textCtx)).stubsCreated).toBe(1);
  });

  it('does not touch customer-confirmed slots (appointment_confirmed)', async () => {
    const p = parts({
      gemini: makeGemini([{
        ...bookedJob(),
        intent: 'appointment_confirmed',
        slotCommitment: null,
      }]),
    });
    const summary = await dispatchSchedulingIntent(deps(p), {
      ...textCtx,
      eventType: 'message.received',
      text: 'Yes, Tuesday at 10 works',
    });
    expect(summary.sentToReview).toBe(0);
    expect(summary.stubsCreated).toBe(1);
  });
});
