import { describe, expect, it, vi } from 'vitest';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import type { QuoMessage } from '@aac/api-clients/quo';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import {
  MemoryStaleQuoteStore,
  analyzeThread,
  assignVariant,
  classifyService,
  computeBookingHorizon,
  expandEvent,
  runStaleQuotes,
  type StaleQuoteDeps,
} from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-04T15:00:00Z'); // a Wednesday

function line(item: string, amount: number, desc = '') {
  return { DetailType: 'SalesItemLineDetail', Amount: amount, Description: desc, SalesItemLineDetail: { ItemRef: { name: item } } };
}

function estimate(over: Partial<QBEstimate> & { lines?: unknown[] } = {}): QBEstimate {
  const { lines, ...rest } = over;
  return {
    Id: '900',
    DocNumber: '1600',
    TxnStatus: 'Pending',
    TxnDate: new Date(NOW - 10 * DAY).toISOString().slice(0, 10),
    TotalAmt: 1175,
    CustomerRef: { value: 'c1', name: 'Pat Example' },
    Line: (lines ?? [line('Crack Injection', 1175)]) as QBEstimate['Line'],
    ...rest,
  } as QBEstimate;
}

function msg(direction: 'incoming' | 'outgoing', at: number, text = 'hi'): QuoMessage {
  return { id: `m${at}`, direction, text, createdAt: new Date(at).toISOString() } as QuoMessage;
}

interface Fake {
  deps: StaleQuoteDeps;
  store: MemoryStaleQuoteStore;
  notes: string[];
  prompts: string[];
}

function fake(opts: {
  estimates?: QBEstimate[];
  messages?: QuoMessage[];
  events?: CalendarEvent[];
  gemini?: (prompt: string) => string;
  now?: () => number;
} = {}): Fake {
  const store = new MemoryStaleQuoteStore();
  const notes: string[] = [];
  const prompts: string[] = [];
  const estimates = opts.estimates ?? [estimate()];
  const tables: Record<string, unknown[]> = {
    Estimate: estimates,
    Customer: [{ Id: 'c1', PrimaryPhone: { FreeFormNumber: '(617) 555-0100' }, BillAddr: { Line1: '12 Elm St', City: 'Quincy' } }],
    Invoice: [],
  };
  const deps: StaleQuoteDeps = {
    qb: {
      query: async <T>(sql: string) => {
        const entity = /FROM (\w+)/.exec(sql)![1];
        return { QueryResponse: { [entity]: tables[entity] } } as T;
      },
      getEstimate: async (id: string) => estimates.find((e) => e.Id === id) ?? null,
    },
    quo: {
      listMessages: async () => ({ data: opts.messages ?? [] }),
      listCalls: async () => ({ data: [] }),
      findContactByPhone: async () => ({ id: 'q1' }),
      createContactNote: async (_id: string, text: string) => {
        notes.push(text);
        return { id: 'n1' };
      },
    } as unknown as StaleQuoteDeps['quo'],
    gemini: {
      generateContent: async (prompt: string) => {
        prompts.push(prompt);
        if (opts.gemini) return opts.gemini(prompt);
        if (prompt.startsWith('Review this outbound SMS')) return '{"ok": true}';
        return 'Hi Pat, just checking back in on the quote I sent over.';
      },
    },
    calendar: { listEvents: async () => opts.events ?? [] },
    gmail: { listMessages: async () => [] },
    store,
    techEmails: ['mike@attackacrack.com'],
    log: () => {},
    now: opts.now ?? (() => NOW),
    throttleMs: 0,
  };
  return { deps, store, notes, prompts };
}

describe('classifyService', () => {
  it('reads item names, not descriptions', () => {
    const e = estimate({ lines: [line('Crack Injection', 1175, 'basement floor and patio steps')] });
    expect(classifyService(e)).toMatchObject({ cls: 'injection', largeResurf: false });
  });
  it('stated square footage decides capacity (450 holds, 285 releases)', () => {
    expect(classifyService(estimate({ lines: [line('Garage resurfacing', 4000, 'approx. 450 square feet')] })).largeResurf).toBe(true);
    expect(classifyService(estimate({ lines: [line('Concrete Resurfacing', 4000, '285 sq ft basement floor')] })).largeResurf).toBe(false);
  });
  it('stair-only work holds over $6k, dollar fallback without footage', () => {
    expect(classifyService(estimate({ lines: [line('Concrete Stair Resurfacing', 5500)] })).largeResurf).toBe(false);
    expect(classifyService(estimate({ lines: [line('Concrete Stair Resurfacing', 6500)] })).largeResurf).toBe(true);
    expect(classifyService(estimate({ lines: [line('Sidewalk repair', 2600)] }))).toMatchObject({ cls: 'exterior-resurf', largeResurf: true });
    expect(classifyService(estimate({ lines: [line('Pool Deck Resurfacing', 900)] }))).toMatchObject({ cls: 'pool-deck', largeResurf: true });
  });
});

describe('assignVariant', () => {
  it('is stable per estimate and inside the A/B cells', () => {
    const v = assignVariant('1234');
    expect(assignVariant('1234')).toEqual(v);
    expect([2, 3]).toContain(v.t1Days);
    expect([10, 14]).toContain(v.t2Days);
  });
});

describe('computeBookingHorizon', () => {
  it('skips weekends and days with jobs or Mike away', () => {
    const ev = (date: string, over: Partial<CalendarEvent> = {}) =>
      expandEvent({ id: date, summary: 'x', start: `${date}T13:00:00Z`, end: `${date}T15:00:00Z`, ...over } as CalendarEvent);
    const events = [ev('2026-11-05', { colorId: '10' }), ev('2026-11-06', { summary: 'Mike vacation' })];
    expect(computeBookingHorizon(events, NOW, []).firstOpen).toBe('2026-11-09');
  });
});

describe('analyzeThread', () => {
  it('counts touches after 3 days and 72h of silence, reset by a reply', () => {
    const quote = NOW - 30 * DAY;
    const t = analyzeThread(
      [msg('outgoing', quote + 4 * DAY), msg('outgoing', quote + 10 * DAY), msg('incoming', quote + 11 * DAY), msg('outgoing', quote + 20 * DAY)],
      quote,
    );
    expect(t.touchesSinceQuote).toBe(3);
    expect(t.unansweredTouches).toBe(1);
  });
});

describe('runStaleQuotes', () => {
  it('live: drafts the due T1, posts the note, saves state, queue and runlog', async () => {
    const f = fake();
    const r = await runStaleQuotes(f.deps, { dryRun: false });
    expect(r.queue.toSend).toHaveLength(1);
    expect(r.queue.toSend[0]).toMatchObject({ doc: '1600', tier: 'T1', phone: '+16175550100' });
    expect(f.notes[0]).toContain('STALE-QUOTE FOLLOW-UP (#1600, T1)');
    expect(f.store.state.estimates['900'].touches).toHaveLength(1);
    expect(f.store.queue?.toSend).toHaveLength(1);
    expect(f.store.runlog[0]).toMatchObject({ outcome: 'drafted', doc: '1600' });
    expect(f.store.awaiting?.entries).toEqual([]);
  });

  it('a Quo note that fails to post is counted as stale-quotes.note_failed; the draft stays queued', async () => {
    const f = fake();
    const countCondition = vi.fn().mockResolvedValue(undefined);
    f.deps.quo.createContactNote = async () => {
      throw new Error('quo 500');
    };
    const r = await runStaleQuotes({ ...f.deps, countCondition }, { dryRun: false });
    expect(r.queue.toSend).toHaveLength(1);
    expect(countCondition).toHaveBeenCalledWith('stale-quotes.note_failed');
  });

  it('a posted note counts nothing', async () => {
    const f = fake();
    const countCondition = vi.fn().mockResolvedValue(undefined);
    await runStaleQuotes({ ...f.deps, countCondition }, { dryRun: false });
    expect(countCondition).not.toHaveBeenCalled();
  });

  it('a same-day rerun re-lists the unsent draft to send, never re-drafts it', async () => {
    const f = fake();
    const first = await runStaleQuotes(f.deps, { dryRun: false });
    const r = await runStaleQuotes(f.deps, { dryRun: false });
    expect(r.draftedThisRun).toBe(0);
    expect(r.queue.toSend).toEqual(first.queue.toSend);
    expect(r.queue.waiting).toHaveLength(0);
    expect(f.notes).toHaveLength(1);
    expect(f.store.state.estimates['900'].touches).toHaveLength(1);
  });

  it('a draft queued on an earlier day and still unsent is listed as waiting', async () => {
    let t = NOW;
    const f = fake({ now: () => t });
    await runStaleQuotes(f.deps, { dryRun: false });
    t = NOW + DAY;
    const r = await runStaleQuotes(f.deps, { dryRun: false });
    expect(r.queue.toSend).toHaveLength(0);
    expect(r.queue.waiting).toHaveLength(1);
    expect(f.notes).toHaveLength(1);
  });

  describe('daily draft cap', () => {
    const eight = (): QBEstimate[] => Array.from({ length: 8 }, (_, i) => estimate({ Id: `9${i}`, DocNumber: `16${i}` }));
    const drafted = (f: Fake): number => Object.values(f.store.state.estimates).reduce((n, s) => n + s.touches.length, 0);

    it('a second run the same Eastern day only finishes what the first left (11/06: 6 + 6)', async () => {
      const f = fake({ estimates: eight() });
      const first = await runStaleQuotes(f.deps, { dryRun: false });
      expect(first.draftedThisRun).toBe(6);
      const second = await runStaleQuotes(f.deps, { dryRun: false });
      expect(second.draftedThisRun).toBe(0);
      expect(second.queue.toSend).toHaveLength(6);
      expect(second.queue.skipped.filter((s) => /daily cap of 6/.test(s.reason))).toHaveLength(2);
      expect(f.notes).toHaveLength(6);
      expect(drafted(f)).toBe(6);
    });

    it('a run cut short by its deadline leaves the rest of the cap to the backstop slot', async () => {
      let t = NOW;
      const f = fake({ estimates: eight(), now: () => t });
      // Each estimate's scan costs 1s of clock; the deadline stops the first run after a few.
      f.deps.quo.listMessages = async () => {
        t += 1000;
        return { data: [] };
      };
      const first = await runStaleQuotes(f.deps, { dryRun: false, deadlineMs: NOW + 2500 });
      expect(first.partial).toBe(true);
      expect(first.draftedThisRun).toBe(3);
      const second = await runStaleQuotes(f.deps, { dryRun: false });
      expect(second.draftedThisRun).toBe(3);
      expect(second.queue.toSend).toHaveLength(6);
      expect(f.notes).toHaveLength(6);
    });

    it('counts only touches queued on the current Eastern day', async () => {
      const f = fake({ estimates: eight() });
      const earlier = (id: string, queuedAt: string) => ({
        estimateId: id, doc: id, customer: 'x', phone: null, firstSeenAt: queuedAt, seasonClass: 'injection' as const,
        largeResurf: false, variant: { t1Days: 2, t2Days: 10 }, touches: [{ tier: 'T1' as const, queuedAt, draft: 'd', sentDetectedAt: queuedAt }],
      });
      // 11/04 02:00Z is still 11/03 in Eastern time; 11/04 05:00Z is 11/04.
      f.store.state.estimates = { a: earlier('a', '2026-11-04T02:00:00.000Z'), b: earlier('b', '2026-11-04T05:00:00.000Z') };
      const r = await runStaleQuotes(f.deps, { dryRun: true });
      expect(r.draftedThisRun).toBe(5);
    });

    it('a one-estimate run ignores the drafts already made today', async () => {
      const f = fake({ estimates: eight() });
      await runStaleQuotes(f.deps, { dryRun: false });
      const r = await runStaleQuotes(f.deps, { dryRun: false, doc: '167' });
      expect(r.draftedThisRun).toBe(1);
    });
  });

  it('a drafted touch is saved before the run finishes (a killed run never re-drafts it)', async () => {
    let drafts = 0;
    const f = fake({
      estimates: [estimate(), estimate({ Id: '901', DocNumber: '1601', TxnDate: new Date(NOW - 11 * DAY).toISOString().slice(0, 10) })],
      gemini: (prompt) => {
        if (prompt.startsWith('Review this outbound SMS')) return '{"ok": true}';
        if (++drafts === 2) throw new Error('function killed');
        return 'Hi Pat, just checking back in.';
      },
    });
    await expect(runStaleQuotes(f.deps, { dryRun: false })).rejects.toThrow();
    expect(f.store.state.estimates['900'].touches).toHaveLength(1);
    expect(f.notes).toHaveLength(1);
  });

  it('dry run writes only the awaiting list, posts nothing', async () => {
    const f = fake();
    const r = await runStaleQuotes(f.deps, { dryRun: true });
    expect(r.queue.toSend).toHaveLength(1);
    expect(f.notes).toHaveLength(0);
    expect(f.store.queue).toBeNull();
    expect(f.store.state.estimates).toEqual({});
    expect(f.store.awaiting).not.toBeNull();
  });

  it('customer spoke last with a real question: awaiting Matt, no draft', async () => {
    const f = fake({
      messages: [msg('outgoing', NOW - 9 * DAY), msg('incoming', NOW - 2 * DAY, 'Can you do Tuesday?')],
      gemini: () => '{"intent":"engaged","confidence":"high","evidence":null,"statedTiming":null,"humanTopic":false,"needsReply":true}',
    });
    const r = await runStaleQuotes(f.deps, { dryRun: false });
    expect(r.queue.toSend).toHaveLength(0);
    expect(r.awaiting).toMatchObject([{ doc: '1600', channel: 'sms', snippet: 'Can you do Tuesday?' }]);
    expect(f.store.state.estimates['900'].suspended?.reason).toBe('awaiting-human');
  });

  it('extraction is cached by last inbound: the second run makes no Gemini call', async () => {
    const f = fake({
      messages: [msg('outgoing', NOW - 9 * DAY), msg('incoming', NOW - 2 * DAY, 'Can you do Tuesday?')],
      gemini: () => '{"intent":"engaged","confidence":"high","evidence":null,"statedTiming":null,"humanTopic":false,"needsReply":true}',
    });
    await runStaleQuotes(f.deps, { dryRun: false });
    const calls = f.prompts.length;
    await runStaleQuotes(f.deps, { dryRun: false });
    expect(f.prompts.length).toBe(calls);
  });

  it('manual holds and booked jobs never draft', async () => {
    const held = fake({ estimates: [estimate({ DocNumber: '1523' })] });
    expect((await runStaleQuotes(held.deps, { dryRun: true })).queue.skipped[0].reason).toMatch(/^manual hold/);
    const booked = fake({
      events: [{ id: 'e', summary: 'Pat Example crack injection', location: '12 Elm St Quincy', colorId: '10', start: new Date(NOW + 3 * DAY).toISOString(), end: new Date(NOW + 3 * DAY + 3600_000).toISOString() } as CalendarEvent],
    });
    const r = await runStaleQuotes(booked.deps, { dryRun: true });
    expect(r.queue.flags[0]).toMatchObject({ kind: 'flip-accepted', doc: '1600' });
    expect(r.queue.toSend).toHaveLength(0);
  });

  it('a scan past its deadline saves state but keeps the last full queue and awaiting list', async () => {
    let t = NOW;
    const f = fake({ estimates: [estimate(), estimate({ Id: '901', DocNumber: '1601' })], now: () => (t += 1000) });
    f.store.queue = { generatedAt: 'before', bookingHorizon: '', toSend: [], waiting: [], flags: [], skipped: [] };
    f.store.awaiting = { generatedAt: 'before', entries: [] };
    const r = await runStaleQuotes(f.deps, { dryRun: false, deadlineMs: NOW + 2500 });
    expect(r.partial).toBe(true);
    expect(f.store.queue.generatedAt).toBe('before');
    expect(f.store.awaiting.generatedAt).toBe('before');
    expect(Object.keys(f.store.state.estimates)).toHaveLength(1);
  });
});

describe('QBO paging', () => {
  it('pulls 1000 rows a page and keeps paging past a full page', async () => {
    const f = fake();
    const sqls: string[] = [];
    const closed = Array.from({ length: 1000 }, (_, i) => estimate({ Id: `f${i}`, DocNumber: `F${i}`, TxnStatus: 'Closed' }));
    f.deps.qb.query = async <T>(sql: string) => {
      sqls.push(sql);
      const entity = /FROM (\w+)/.exec(sql)![1]!;
      const start = Number(/STARTPOSITION (\d+)/.exec(sql)![1]);
      const rows: Record<string, unknown[]> = {
        Estimate: start === 1 ? closed : [estimate()],
        Customer: [{ Id: 'c1', PrimaryPhone: { FreeFormNumber: '(617) 555-0100' } }],
        Invoice: [],
      };
      return { QueryResponse: { [entity]: rows[entity] } } as T;
    };
    const r = await runStaleQuotes(f.deps, { dryRun: true });
    const est = sqls.filter((s) => s.includes('FROM Estimate'));
    expect(est).toHaveLength(2);
    expect(est[0]).toContain('STARTPOSITION 1 MAXRESULTS 1000');
    expect(est[1]).toContain('STARTPOSITION 1001 MAXRESULTS 1000');
    expect(sqls.every((s) => s.includes('MAXRESULTS 1000'))).toBe(true);
    // The Pending quote on page 2 was seen.
    expect(r.queue.toSend.map((d) => d.doc)).toEqual(['1600']);
  });
});
