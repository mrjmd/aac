import { describe, it, expect, vi } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QuoCall } from '@aac/api-clients/quo';
import {
  MemoryTriageStore,
  addrKey,
  addrsAlike,
  analyze,
  collect,
  type AnalyzeDeps,
  type CollectDeps,
  type Snapshot,
  type TriageGemini,
} from '../src/index.js';

const NOW = new Date('2026-11-05T15:00:00Z').getTime();
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'ev',
    summary: 'Event',
    start: iso(NOW),
    end: iso(NOW + 3_600_000),
    attendees: [],
    htmlLink: '',
    attachments: [],
    ...overrides,
  } as CalendarEvent;
}

function fixtureSnapshot(): Snapshot {
  return {
    generatedAt: iso(NOW - 60_000),
    windows: {
      calendarFrom: iso(NOW - 60 * DAY),
      calendarTo: iso(NOW + 60 * DAY),
      qboSince: iso(NOW - 180 * DAY).slice(0, 10),
      quoActiveSince: iso(NOW - 21 * DAY),
    },
    calendar: [
      // D10: stub tomorrow → red
      event({ id: 'stub1', summary: 'STUB — Jane Roe', colorId: '3', start: iso(NOW + DAY), end: iso(NOW + DAY + 3_600_000) }),
    ],
    estimates: [],
    invoices: [
      // D2: created 5 days ago, never emailed
      {
        Id: '900',
        DocNumber: '1900',
        TxnDate: iso(NOW - 5 * DAY).slice(0, 10),
        TotalAmt: 675,
        Balance: 675,
        EmailStatus: 'NotSet',
        CustomerRef: { value: '77', name: 'Bob Builder' },
      },
    ],
    customers: [],
    completions: {},
    scheduling: { pending: [], review: [] },
    todos: [],
    worker: {
      messageDraftRecords: [],
      quoteDrafterRunlog: [],
      scopeFlags: [],
      messageDraftsHeartbeat: iso(NOW - 120_000),
      quoteDrafterHeartbeat: iso(NOW - 120_000),
      quoteDrafterModeOverride: null,
    },
    threads: [],
    emails: [],
    stats: {},
  };
}

function fakeGemini(): TriageGemini {
  return {
    extractEntities: vi.fn().mockResolvedValue({ firstName: 'Canary' }),
    generateContent: vi.fn().mockResolvedValue('{"needs_action": false, "category": "none"}'),
  } as unknown as TriageGemini;
}

function analyzeDeps(store: MemoryTriageStore, gemini = fakeGemini()): AnalyzeDeps {
  return {
    geminiApiKey: 'test',
    createGemini: () => gemini,
    store,
    quoPhoneNumber: '+16176681677',
    technicianEmails: ['mike@attackacrack.com'],
    now: () => NOW,
    log: () => {},
  };
}

describe('analyze detectors', () => {
  it('flags an unsent invoice (D2) and an imminent stub (D10)', async () => {
    const out = await analyze(fixtureSnapshot(), analyzeDeps(new MemoryTriageStore()));
    const d2 = out.findings.find((f) => f.id === 'd2:900');
    expect(d2).toMatchObject({ section: 'cash_not_sent', severity: 'red', amount: 675, ageDays: 5 });
    const d10 = out.findings.find((f) => f.id === 'd10:stub1');
    expect(d10).toMatchObject({ section: 'stub_review', severity: 'red', customer: 'Jane Roe', dueOn: iso(NOW + DAY) });
    expect(out.generatedAt).toBe(iso(NOW));
    expect(out.stats.geminiCanaryOk).toBe(1);
    expect(out.pulse.arOpenTotal).toBe(675);
  });

  it('turns a failing canary into a red system finding', async () => {
    const gemini = fakeGemini();
    (gemini.extractEntities as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('model retired'));
    const out = await analyze(fixtureSnapshot(), analyzeDeps(new MemoryTriageStore(), gemini));
    expect(out.findings.find((f) => f.id === 'system-gemini-canary')).toMatchObject({ severity: 'red' });
  });

  it('feeds a cached transcript into the thread prompt', async () => {
    const store = new MemoryTriageStore();
    store.transcripts.set('call1', {
      phone: '+16175550100',
      at: iso(NOW - DAY),
      dialogue: [{ identifier: '+16175550100', content: 'Can you quote my bulkhead?' }],
    });
    const snap = fixtureSnapshot();
    snap.threads = [
      {
        phone: '+16175550100',
        conversationId: 'c1',
        lastActivityAt: iso(NOW - DAY),
        messages: [],
        calls: [{ id: 'call1', direction: 'incoming', status: 'completed', at: iso(NOW - DAY), durationSec: 120, hasTranscript: true }],
      },
    ];
    const gemini = fakeGemini();
    await analyze(snap, analyzeDeps(store, gemini));
    const prompt = (gemini.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('C: Can you quote my bulkhead?');
  });
});

describe('dismissals', () => {
  it('drops matching findings and counts them', async () => {
    const store = new MemoryTriageStore();
    store.dismissals = [{ match: 'bob builder', sections: ['cash_not_sent'], reason: 'paid cash' }];
    const out = await analyze(fixtureSnapshot(), analyzeDeps(store));
    expect(out.findings.some((f) => f.id === 'd2:900')).toBe(false);
    expect(out.stats.dismissed).toBe(1);
  });

  it('ignores expired holds and other sections', async () => {
    const store = new MemoryTriageStore();
    store.dismissals = [
      { match: 'Bob Builder', until: '2026-11-04' },
      { match: 'Bob Builder', sections: ['cash_overdue'] },
    ];
    const out = await analyze(fixtureSnapshot(), analyzeDeps(store));
    expect(out.findings.some((f) => f.id === 'd2:900')).toBe(true);
    expect(out.stats.dismissed).toBe(0);
  });

  it('skips the filter entirely when no dismissals are configured', async () => {
    const out = await analyze(fixtureSnapshot(), analyzeDeps(new MemoryTriageStore()));
    expect(out.stats.dismissed).toBeUndefined();
  });
});

describe('address helpers', () => {
  it('needs the house number and a street token to agree', () => {
    expect(addrsAlike(addrKey('12 Iron Hill Rd, Quincy'), addrKey('12 Iron Hill Road'))).toBe(true);
    expect(addrsAlike(addrKey('12 Iron Hill Rd'), addrKey('14 Iron Hill Rd'))).toBe(false);
    expect(addrsAlike(addrKey('12 Iron Hill Rd'), addrKey('12 Oak Hill Rd'))).toBe(true); // number + 'hill'
    expect(addrsAlike(addrKey('Iron Hill'), addrKey('Oak Hill'))).toBe(false);
  });
});

// ── collect: transcript + voicemail cache ────────────────────────────

const PHONE = '+16175550100';

function call(overrides: Partial<QuoCall>): QuoCall {
  return {
    id: 'call',
    to: '+16176681677',
    from: PHONE,
    phoneNumberId: 'pn',
    direction: 'incoming',
    status: 'completed',
    duration: 120,
    createdAt: iso(NOW - DAY),
    ...overrides,
  };
}

function collectDeps(store: MemoryTriageStore, calls: QuoCall[]) {
  const quo = {
    listConversations: vi.fn().mockResolvedValue({
      data: [{ id: 'c1', phoneNumberId: 'pn', participants: [PHONE], lastActivityAt: iso(NOW - DAY) }],
    }),
    listMessages: vi.fn().mockResolvedValue({ data: [] }),
    listCalls: vi.fn().mockResolvedValue({ data: calls }),
    getCallTranscript: vi.fn().mockResolvedValue({
      callId: 'x',
      status: 'completed',
      dialogue: [{ identifier: PHONE, content: 'hello' }],
    }),
    getCallVoicemail: vi.fn().mockResolvedValue(null),
  };
  const deps: CollectDeps = {
    redis: {
      pipeline: vi.fn(),
      lrange: vi.fn().mockResolvedValue([]),
      zrange: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as CollectDeps['redis'],
    qb: { query: vi.fn().mockResolvedValue({ QueryResponse: {} }) } as unknown as CollectDeps['qb'],
    quo: quo as unknown as CollectDeps['quo'],
    calendar: { listEvents: vi.fn().mockResolvedValue([]) },
    gmail: () => ({ listMessages: vi.fn().mockResolvedValue([]) }),
    store,
    quoPhoneNumber: '+16176681677',
    now: () => NOW,
    log: () => {},
  };
  return { deps, quo };
}

describe('collect transcript cache', () => {
  it('fetches and caches a transcript on a miss', async () => {
    const store = new MemoryTriageStore();
    const { deps, quo } = collectDeps(store, [call({ id: 'call1' })]);
    const snap = await collect(deps);
    expect(quo.getCallTranscript).toHaveBeenCalledWith('call1');
    expect(store.transcripts.get('call1')).toEqual({
      phone: PHONE,
      at: iso(NOW - DAY),
      dialogue: [{ identifier: PHONE, content: 'hello' }],
    });
    expect(snap.threads[0].calls[0].hasTranscript).toBe(true);
    expect(snap.stats.transcriptsFetched).toBe(1);
    expect(snap.stats.transcriptsCached).toBe(0);
  });

  it('uses the cache on a hit without calling Quo', async () => {
    const store = new MemoryTriageStore();
    store.transcripts.set('call1', { phone: PHONE, at: iso(NOW - DAY), dialogue: [] });
    const { deps, quo } = collectDeps(store, [call({ id: 'call1' })]);
    const snap = await collect(deps);
    expect(quo.getCallTranscript).not.toHaveBeenCalled();
    expect(snap.threads[0].calls[0].hasTranscript).toBe(true);
    expect(snap.stats.transcriptsCached).toBe(1);
  });

  it('caches nothing when the transcript is not completed or the fetch fails', async () => {
    const store = new MemoryTriageStore();
    const { deps, quo } = collectDeps(store, [call({ id: 'a' }), call({ id: 'b' })]);
    quo.getCallTranscript
      .mockResolvedValueOnce({ callId: 'a', status: 'in-progress', dialogue: null })
      .mockRejectedValueOnce(new Error('Quo API error: 500 - boom'));
    const snap = await collect(deps);
    expect(store.transcripts.size).toBe(0);
    expect(snap.threads[0].calls.every((c) => !c.hasTranscript)).toBe(true);
  });
});

describe('collect voicemail cache', () => {
  const rangOut = call({ id: 'vm1', status: 'no-answer', duration: 0 });

  it('caches {transcript: null} on a 404 and does not re-probe', async () => {
    const store = new MemoryTriageStore();
    const { deps, quo } = collectDeps(store, [rangOut]);
    const snap = await collect(deps);
    expect(store.voicemails.get('vm1')).toEqual({ phone: PHONE, at: iso(NOW - DAY), transcript: null });
    expect(snap.threads[0].calls[0].voicemail).toBeUndefined();
    expect(snap.stats.voicemailsFetched).toBe(0);

    const second = collectDeps(store, [rangOut]);
    const snap2 = await collect(second.deps);
    expect(second.quo.getCallVoicemail).not.toHaveBeenCalled();
    expect(snap2.stats.voicemailsCached).toBe(1);
    expect(quo.getCallVoicemail).toHaveBeenCalledTimes(1);
  });

  it('caches a completed voicemail and puts it on the call', async () => {
    const store = new MemoryTriageStore();
    const { deps, quo } = collectDeps(store, [rangOut]);
    quo.getCallVoicemail.mockResolvedValue({ status: 'completed', transcript: 'Call me back' });
    const snap = await collect(deps);
    expect(snap.threads[0].calls[0].voicemail).toBe('Call me back');
    expect(store.voicemails.get('vm1')?.transcript).toBe('Call me back');
  });

  it('caches nothing while processing or on other errors', async () => {
    const store = new MemoryTriageStore();
    const { deps, quo } = collectDeps(store, [rangOut, call({ id: 'vm2', status: 'no-answer', duration: 0 })]);
    quo.getCallVoicemail
      .mockResolvedValueOnce({ status: 'in-progress', transcript: null })
      .mockRejectedValueOnce(new Error('Quo API error: 500 - boom'));
    await collect(deps);
    expect(store.voicemails.size).toBe(0);
  });
});
