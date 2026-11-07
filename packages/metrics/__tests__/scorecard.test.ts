import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBEstimate, QBInvoice, QBPayment } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import { buildScorecard, leadFactOf, matchJobInvoices, quoteSentDay, quoteWon, refreshLeadFacts, SCORECARD_GOALS, scorecardWeeks, weekTarget, type LeadFact } from '../src/index.js';

// Friday 11/6/2026, 3pm Eastern. Closed weeks run 8/3 .. 10/26, this week is 11/2.
const now = new Date('2026-11-06T20:00:00Z');
const MIKE = 'mike@attackacrack.com';

const est = (o: Partial<QBEstimate>): QBEstimate => ({ Id: 'e', SyncToken: '0', CustomerRef: { value: 'c' }, Line: [], ...o }) as QBEstimate;
const ev = (start: string, colorId: string, summary = 'Customer', o: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: start + summary, summary, start, end: start, colorId, attendees: [MIKE], ...o }) as CalendarEvent;
const msg = (direction: 'incoming' | 'outgoing', createdAt: string): QuoMessage => ({ direction, createdAt }) as QuoMessage;
const call = (direction: 'incoming' | 'outgoing', createdAt: string, answeredAt?: string): QuoCall =>
  ({ direction, createdAt, ...(answeredAt ? { answeredAt } : {}) }) as QuoCall;

const base = { now, leads: {}, estimates: [], payments: [], invoices: [], events: [], techEmails: [MIKE], spend: [] };
const row = (sc: ReturnType<typeof buildScorecard>, key: string) => sc.rows.find((r) => r.key === key)!;

describe('scorecard weeks', () => {
  it('shows 13 closed weeks then this week, and last year 52 weeks before the last closed one', () => {
    const { weeks, lastYear } = scorecardWeeks('2026-11-06');
    expect(weeks).toHaveLength(14);
    expect(weeks[0]).toBe('2026-08-03');
    expect(weeks[12]).toBe('2026-10-26');
    expect(weeks[13]).toBe('2026-11-02');
    expect(lastYear).toBe('2025-10-27');
  });
});

describe('seasonal targets', () => {
  it('scales volume goals by the month the week falls in and keeps rates flat', () => {
    // Week of 10/26: its Thursday is 10/29, an October week. Week of 11/2 is November.
    expect(weekTarget('leads', 27, '2026-10-26', 'int')).toBe(31);
    expect(weekTarget('leads', 27, '2026-11-02', 'int')).toBe(16);
    expect(weekTarget('quoted', 18, '2026-11-02', 'usdk')).toBe(12.6);
    expect(weekTarget('close', 55, '2026-11-02', 'pct')).toBe(55);
    expect(weekTarget('assessments', null, '2026-11-02', 'int')).toBeNull();
  });

  it('lags payments half a month behind the invoicing season', () => {
    // December: half December's invoiced index (0.71), half November's (0.91) = 0.81.
    expect(weekTarget('collected', 11.5, '2026-12-07', 'usdk')).toBe(9.3);
  });

  it('gives each seasonal row a target per week and for last year', () => {
    const sc = buildScorecard(base);
    const leads = row(sc, 'leads');
    expect(leads.seasonal).toBe(true);
    expect(leads.targets[12]).toBe(31);
    expect(leads.lastYearTarget).toBe(31);
    expect(row(sc, 'collected').seasonal).toBe(true);
    expect(row(sc, 'close').seasonal).toBeUndefined();
    expect(row(sc, 'close').targets.every((t) => t === SCORECARD_GOALS.close)).toBe(true);
  });
});

describe('quotes', () => {
  it('dates a quote by when it was emailed, and skips unsent pending drafts', () => {
    expect(quoteSentDay(est({ TxnDate: '2026-10-01', DeliveryInfo: { DeliveryTime: '2026-10-03T02:00:00Z' } }))).toBe('2026-10-02');
    expect(quoteSentDay(est({ TxnDate: '2026-10-01', TxnStatus: 'Pending', EmailStatus: 'NeedToSend' }))).toBeNull();
    expect(quoteSentDay(est({ TxnDate: '2026-10-01', TxnStatus: 'Accepted' }))).toBe('2026-10-01');
  });

  it('counts accepted, converted or invoiced quotes as won', () => {
    expect(quoteWon(est({ TxnStatus: 'Accepted' }))).toBe(true);
    expect(quoteWon(est({ TxnStatus: 'Closed', LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }))).toBe(true);
    expect(quoteWon(est({ TxnStatus: 'Closed' }))).toBe(false);
  });

  it('counts sent quotes and their total per week, and close rate on quotes 4-8 weeks old', () => {
    const sc = buildScorecard({
      ...base,
      estimates: [
        est({ TxnDate: '2026-10-27', TxnStatus: 'Pending', EmailStatus: 'EmailSent', TotalAmt: 1175 }),
        est({ TxnDate: '2026-10-28', TxnStatus: 'Accepted', TotalAmt: 2000 }),
        est({ TxnDate: '2026-10-29', TxnStatus: 'Pending', EmailStatus: 'NeedToSend', TotalAmt: 900 }),
        // Cohort for the 10/26 week: sent 9/7 .. 10/4.
        est({ TxnDate: '2026-09-10', TxnStatus: 'Accepted' }),
        est({ TxnDate: '2026-09-20', TxnStatus: 'Pending', EmailStatus: 'EmailSent' }),
      ],
    });
    expect(row(sc, 'quotes').values[12]).toBe(2);
    expect(row(sc, 'quoted').values[12]).toBe(3.2);
    expect(row(sc, 'close').values[12]).toBe(50);
    expect(row(sc, 'close').values[0]).toBeNull();
  });
});

describe('getting paid', () => {
  const inv = (Id: string, name: string, TxnDate: string, TotalAmt: number, Balance: number) =>
    ({ Id, TxnDate, TotalAmt, Balance, SyncToken: '0', CustomerRef: { value: Id, name }, Line: [] }) as unknown as QBInvoice;
  const pay = (TxnDate: string, TxnId: string, Amount: number) =>
    ({ Id: TxnDate + TxnId, SyncToken: '0', TxnDate, TotalAmt: Amount, CustomerRef: { value: 'c' }, Line: [{ Amount, LinkedTxn: [{ TxnId, TxnType: 'Invoice' }] }] }) as QBPayment;

  it('matches a job to its invoice by surname first, then the nearest date', () => {
    const job = ev('2026-10-13T12:00:00Z', '10', 'Teddy Watler');
    const m = matchJobInvoices([job], [inv('a', 'Teddy Smith', '2026-10-13', 1, 0), inv('b', 'Ted Watler', '2026-10-19', 1, 0), inv('c', 'Watler', '2026-12-30', 1, 0)]);
    expect(m.get(job.id)?.Id).toBe('b');
  });

  it('averages days from job to paid off, counting an unpaid job by its days so far, and names unmatched jobs', () => {
    const sc = buildScorecard({
      ...base,
      events: [
        ev('2026-10-27T12:00:00Z', '10', 'Ann Paid'),
        ev('2026-10-28T12:00:00Z', '10', 'Bob Open'),
        ev('2026-10-29T12:00:00Z', '10', 'Julian'),
        // Second day of Bob's job, not titled [cont]: not a job of its own.
        ev('2026-10-30T12:00:00Z', '10', 'Bob Open'),
      ],
      invoices: [inv('a', 'Ann Paid', '2026-10-27', 1000, 0), inv('b', 'Bob Open', '2026-10-28', 500, 500)],
      payments: [pay('2026-10-25', 'a', 300), pay('2026-11-01', 'a', 700)],
    });
    // Ann: paid off 11/1, 5 days. Bob: open, 10/28 to today 11/6, 9 days. (5 + 9) / 2 = 7.
    expect(row(sc, 'jobpay').values[12]).toBe(7);
    expect(sc.gaps.join()).toContain('no invoice found for 1 job (Julian 10-29)');
    expect(row(sc, 'jobs').values[12]).toBe(3);
  });

  it("counts balances over 30 days old as of each week's end, before later payments", () => {
    const sc = buildScorecard({
      ...base,
      invoices: [inv('a', 'Old Debt', '2026-08-01', 900, 0), inv('b', 'Recent', '2026-10-20', 400, 400)],
      payments: [pay('2026-10-30', 'a', 900)],
    });
    // Week of 10/19 (ends 10/25): the 8/1 invoice was still open, the 10/20 one isn't 30 days old.
    expect(row(sc, 'owed30').values[11]).toBe(0.9);
    // Week of 10/26 (ends 11/1): paid 10/30.
    expect(row(sc, 'owed30').values[12]).toBe(0);
  });
});

describe('calendar rows', () => {
  it('counts jobs once per job (not [cont] days, not HOLDs, not the future) and assessments', () => {
    const sc = buildScorecard({
      ...base,
      events: [
        ev('2026-10-13T12:00:00Z', '10', 'Teddy Watler'),
        ev('2026-10-14T12:00:00Z', '10', 'Teddy Watler [cont]'),
        ev('2026-10-15T12:00:00Z', '10', 'HOLD — Someone'),
        ev('2026-10-16T17:00:00Z', '3', 'Joshua Baker'),
        ev('2026-11-09T12:00:00Z', '10', 'Shivani'),
      ],
    });
    expect(row(sc, 'jobs').values[10]).toBe(1);
    expect(row(sc, 'assessments').values[10]).toBe(1);
    expect(row(sc, 'jobs').values[13]).toBe(0);
  });

  it('measures work booked ahead with only the events that existed that Monday', () => {
    const sc = buildScorecard({
      ...base,
      events: [
        { ...ev('2026-10-20T12:00:00Z', '10'), end: '2026-10-20T20:00:00Z', created: '2026-10-01T00:00:00Z' },
        { ...ev('2026-10-21T12:00:00Z', '10'), end: '2026-10-21T20:00:00Z', created: '2026-10-19T18:00:00Z' },
      ],
    });
    // As of Monday 10/19 8am only the first 8-hour day was on the calendar: 8 / 40.
    expect(row(sc, 'booked').values[11]).toBe(0.2);
    expect(row(sc, 'booked').values[12]).toBe(0);
  });
});

describe('leads', () => {
  it('reads the first inbound contact and our first reply, counting an answered call as a reply', () => {
    expect(
      leadFactOf([msg('outgoing', '2026-10-01T10:00:00Z'), msg('incoming', '2026-10-05T10:00:00Z'), msg('outgoing', '2026-10-05T12:00:00Z')], [], now),
    ).toMatchObject({ at: '2026-10-05T10:00:00Z', replyAt: '2026-10-05T12:00:00Z' });
    expect(leadFactOf([], [call('incoming', '2026-10-05T10:00:00Z', '2026-10-05T10:00:09Z')], now).replyAt).toBe('2026-10-05T10:00:09Z');
    expect(leadFactOf([msg('outgoing', '2026-10-01T10:00:00Z')], [], now).at).toBeNull();
  });

  it('counts new contacts per week and the p75 reply among the ones we answered, leaving out existing customers', () => {
    const leads: Record<string, LeadFact> = {
      a: { at: '2026-10-27T14:00:00Z', replyAt: '2026-10-27T15:00:00Z', checkedAt: '' },
      b: { at: '2026-10-28T14:00:00Z', replyAt: '2026-10-28T18:00:00Z', checkedAt: '' },
      c: { at: '2026-10-29T14:00:00Z', replyAt: null, checkedAt: '' },
      d: { at: '2026-10-29T14:00:00Z', replyAt: null, checkedAt: '', existing: true },
      e: { at: null, replyAt: null, checkedAt: '' },
    };
    const sc = buildScorecard({ ...base, leads });
    expect(row(sc, 'leads').values[12]).toBe(3);
    expect(row(sc, 'reply').values[12]).toBe(4);
    expect(row(sc, 'reply').values[0]).toBeNull();
  });

  it('names a missing Ads source instead of showing zero spend', () => {
    const sc = buildScorecard({ ...base, spend: null });
    expect(row(sc, 'spend').values[12]).toBeNull();
    expect(sc.gaps).toContain('Google Ads spend (Ads not configured)');
  });

  it('refreshes only unsettled phones whose threads moved, keeping a seeded first contact', async () => {
    const store: Record<string, LeadFact> = {
      '+16175550001': { at: '2026-10-01T10:00:00Z', replyAt: '2026-10-01T11:00:00Z', checkedAt: '2026-10-02T00:00:00Z' },
      '+16175550002': { at: '2026-10-01T10:00:00Z', replyAt: null, checkedAt: '2026-10-02T00:00:00Z' },
    };
    const conv = (p: string) => ({ id: p, phoneNumberId: 'PN', participants: ['+16176681677', p], lastActivityAt: '2026-11-05T00:00:00Z', createdAt: '', updatedAt: '' });
    const fetched: string[] = [];
    const quo = {
      listConversations: async () => ({ data: [conv('+16175550001'), conv('+16175550002'), conv('+16175550003'), conv('+16177660151')], nextPageToken: null }),
      listMessages: async ({ participantE164 }: { participantE164: string | string[] }) => {
        fetched.push(String(participantE164));
        return participantE164 === '+16175550002'
          ? { data: [msg('incoming', '2026-11-04T10:00:00Z'), msg('outgoing', '2026-11-04T12:00:00Z')] }
          : { data: [msg('incoming', '2026-11-05T09:00:00Z')] };
      },
      listCalls: async () => ({ data: [] }),
    };
    const redis = {
      hgetall: async <T,>() => ({ ...store }) as T,
      hset: async <T,>(_k: string, kv: Record<string, T>) => {
        Object.assign(store, kv);
        return 1;
      },
    };
    const r = await refreshLeadFacts(
      { quo: quo as never, redis, ownLine: '+16176681677', leadsKey: 'k' },
      { since: new Date('2026-11-01T00:00:00Z'), now, deadlineMs: Date.now() + 60_000 },
    );
    expect(fetched.sort()).toEqual(['+16175550002', '+16175550003']);
    expect(r).toMatchObject({ checked: 2, added: 1, partial: false });
    expect(store['+16175550002']).toMatchObject({ at: '2026-10-01T10:00:00Z', replyAt: '2026-11-04T12:00:00Z' });
    expect(store['+16175550003']).toMatchObject({ at: '2026-11-05T09:00:00Z', replyAt: null });
  });
});

describe('records behind each cell (click-through)', () => {
  it('lists the quotes, leads, jobs and payments a cell counts, agreeing with its number', () => {
    const sc = buildScorecard({
      ...base,
      leads: {
        '+16175550101': { at: '2026-10-27T14:00:00Z', replyAt: '2026-10-27T16:00:00Z', checkedAt: '2026-11-06T00:00:00Z' },
        '+16175550102': { at: '2026-10-28T14:00:00Z', replyAt: null, checkedAt: '2026-11-06T00:00:00Z' },
      },
      estimates: [
        est({ Id: '1', DocNumber: '1590', TxnDate: '2026-10-28', TxnStatus: 'Pending', EmailStatus: 'EmailSent', TotalAmt: 1175, CustomerRef: { value: 'c', name: 'Jane Doe' } }),
        est({ Id: '2', DocNumber: '1591', TxnDate: '2026-10-29', TxnStatus: 'Accepted', TotalAmt: 2350, CustomerRef: { value: 'd', name: 'Bob Roe' } }),
      ],
      events: [ev('2026-10-27T14:00:00Z', '10', 'Jane Doe - crack injection', { end: '2026-10-27T18:00:00Z' })],
      payments: [{ Id: 'p', SyncToken: '0', TxnDate: '2026-10-30', TotalAmt: 675, CustomerRef: { value: 'c', name: 'Jane Doe' } } as QBPayment],
    });
    const k = 12; // week of 10/26
    const quotes = row(sc, 'quotes');
    expect(quotes.records![k]!.map((r) => r.label)).toEqual(['#1590 Jane Doe', '#1591 Bob Roe']);
    expect(quotes.records![k]).toHaveLength(quotes.values[k]!);
    expect(row(sc, 'quoted').records![k]!.map((r) => r.value)).toEqual(['$1,175', '$2,350']);
    const leads = row(sc, 'leads').records![k]!;
    expect(leads.map((r) => [r.label, r.note])).toEqual([
      ['+16175550101', 'First reply after 2h'],
      ['+16175550102', 'No reply yet'],
    ]);
    expect(row(sc, 'reply').records![k]!.map((r) => r.value)).toEqual(['2h']);
    const job = row(sc, 'jobs').records![k]![0]!;
    expect([job.label, job.customer, job.note]).toEqual(['Jane Doe - crack injection', 'Jane Doe', 'No invoice matched']);
    expect(row(sc, 'collected').records![k]!.map((r) => [r.label, r.value])).toEqual([['Jane Doe', '$675']]);
    expect(row(sc, 'collected').lastYearRecords).toEqual([]);
  });
});
