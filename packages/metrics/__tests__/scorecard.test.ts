import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBEstimate, QBInvoice, QBPayment } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import { buildScorecard, leadFactOf, quoteSentDay, quoteWon, refreshLeadFacts, SCORECARD_GOALS, scorecardWeeks, weekTarget, type LeadFact } from '../src/index.js';

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

describe('days to get paid', () => {
  it('averages invoice-to-payment days by dollars over the 4 weeks ending each week', () => {
    const inv = (Id: string, TxnDate: string) => ({ Id, TxnDate, SyncToken: '0', CustomerRef: { value: 'c' }, Line: [] }) as unknown as QBInvoice;
    const pay = (TxnDate: string, lines: Array<[string, number]>) =>
      ({ Id: TxnDate, SyncToken: '0', TxnDate, TotalAmt: 0, CustomerRef: { value: 'c' }, Line: lines.map(([TxnId, Amount]) => ({ Amount, LinkedTxn: [{ TxnId, TxnType: 'Invoice' }] })) }) as QBPayment;
    const sc = buildScorecard({
      ...base,
      invoices: [inv('a', '2026-10-01'), inv('b', '2026-10-27')],
      // $1,000 paid 30 days late, $3,000 paid the same day: (30×1000 + 0×3000) / 4000 = 7.5 → 8.
      payments: [pay('2026-10-31', [['a', 1000]]), pay('2026-10-27', [['b', 3000]]), pay('2026-10-28', [['unknown', 500]])],
    });
    expect(row(sc, 'paylag').values[12]).toBe(8);
    // Still inside the next week's 4-week window, gone 4 weeks later.
    expect(row(sc, 'paylag').values[13]).toBe(8);
    expect(row(sc, 'paylag').values[8]).toBeNull();
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
