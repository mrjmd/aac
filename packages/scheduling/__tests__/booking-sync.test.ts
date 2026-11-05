import { describe, it, expect, vi } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBCustomer, QBEstimate } from '@aac/api-clients/quickbooks';
import { BOT_DRAFT_MARKER } from '@aac/quoting';
import {
  customersForBooking,
  decideBooking,
  isBookedJob,
  syncBookedEstimates,
  type BookingSyncDeps,
} from '../src/booking-sync.js';

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev-1',
    summary: 'Artie Downey',
    start: '2026-11-12T13:00:00Z',
    end: '2026-11-12T17:00:00Z',
    colorId: '10',
    attendees: [],
    htmlLink: '',
    attachments: [],
    ...over,
  };
}

function cust(over: Partial<QBCustomer> = {}): QBCustomer {
  return { Id: 'c1', DisplayName: 'Arthur Downey', ...over };
}

function est(over: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: 'e1',
    SyncToken: '0',
    DocNumber: '1580',
    TxnDate: '2026-10-20',
    TxnStatus: 'Pending',
    CustomerRef: { value: 'c1' },
    Line: [],
    ...over,
  };
}

describe('isBookedJob', () => {
  it('counts green jobs only', () => {
    expect(isBookedJob({ colorId: '10' })).toBe(true);
    for (const c of ['3', '5', '8', undefined]) expect(isBookedJob({ colorId: c })).toBe(false);
  });
});

describe('customersForBooking', () => {
  it('matches a phone in the description in any format', () => {
    const c = cust({ PrimaryPhone: { FreeFormNumber: '(781) 555-0142' } });
    const m = customersForBooking(ev({ summary: 'Downey', description: 'Call 781.555.0142 on arrival' }), [c]);
    expect(m).toEqual([{ customer: c, via: ['phone'] }]);
  });

  it('matches the name strictly, with the STUB prefix and "Last, First" display names', () => {
    const c = cust({ DisplayName: 'Downey, Artie' });
    expect(customersForBooking(ev({ summary: 'STUB — Artie Downey' }), [c])[0].via).toEqual(['name']);
    // A bare surname never claims a customer.
    expect(customersForBooking(ev({ summary: 'Downey' }), [c])).toEqual([]);
  });

  it('matches the address when the booking name differs from QBO (Champion Builders / Sarah Dacey)', () => {
    const c = cust({ DisplayName: 'Champion Builders', BillAddr: { Line1: '138 Elm Street, Unit Number 35' } });
    const m = customersForBooking(ev({ summary: 'Sarah Dacey', location: '138 Elm St unit 35, Kingston MA' }), [c]);
    expect(m[0].via).toEqual(['address']);
  });

  it('ignores an address shared by 3+ customers (a hub)', () => {
    const at = { BillAddr: { Line1: '1 Main Street' } };
    const cs = [cust({ Id: 'a', ...at }), cust({ Id: 'b', ...at }), cust({ Id: 'c', ...at })];
    expect(customersForBooking(ev({ summary: 'Job', location: '1 Main St' }), cs)).toEqual([]);
  });
});

describe('decideBooking', () => {
  const match = (estimates: QBEstimate[]) => [{ customer: cust(), via: ['name' as const], estimates }];

  it('accepts the one open quote', () => {
    const d = decideBooking(ev(), match([est()]));
    expect(d).toMatchObject({ kind: 'accept', estimate: { Id: 'e1' } });
  });

  it('does nothing when an Accepted quote already covers the booking', () => {
    expect(decideBooking(ev(), match([est(), est({ Id: 'e2', TxnStatus: 'Accepted' })]))).toEqual({
      kind: 'covered',
      estimateId: 'e2',
    });
  });

  it('never guesses between two open quotes', () => {
    expect(decideBooking(ev(), match([est(), est({ Id: 'e2' })]))).toEqual({
      kind: 'ambiguous',
      estimateIds: ['e1', 'e2'],
    });
  });

  it('ignores quotes outside the window and unsent bot drafts', () => {
    const old = est({ Id: 'old', TxnDate: '2026-03-01' });
    const bot = est({ Id: 'bot', PrivateNote: `${BOT_DRAFT_MARKER} draft` });
    expect(decideBooking(ev(), match([old, bot]))).toEqual({ kind: 'none' });
    // A bot draft Matt reviewed and sent is a real quote.
    expect(decideBooking(ev(), match([{ ...bot, EmailStatus: 'EmailSent' }]))).toMatchObject({ kind: 'accept' });
  });

  it('counts open quotes across every matched customer', () => {
    const d = decideBooking(ev(), [
      ...match([est()]),
      { customer: cust({ Id: 'c2' }), via: ['address'], estimates: [est({ Id: 'e9', CustomerRef: { value: 'c2' } })] },
    ]);
    expect(d.kind).toBe('ambiguous');
  });
});

describe('syncBookedEstimates', () => {
  function deps(estimates: QBEstimate[], outcomes: Record<string, string> = {}) {
    const calls: string[] = [];
    const d: BookingSyncDeps = {
      qb: {
        listAllCustomers: vi.fn(async () => [cust()]),
        getEstimatesByCustomer: vi.fn(async () => estimates),
        updateEstimate: vi.fn(async (id: string) => {
          calls.push(`update:${id}`);
          return est({ Id: id, TxnStatus: 'Accepted' });
        }),
      },
      getEventOutcome: vi.fn(async (id: string) => outcomes[id] ?? null),
      setEventOutcome: vi.fn(async (id: string, o: string, final: boolean) => {
        calls.push(`outcome:${id}:${o}:${final}`);
      }),
      markEstimateHandled: vi.fn(async (id: string, marker: string) => {
        calls.push(`handled:${id}:${marker}`);
      }),
    };
    return { d, calls };
  }

  it('stamps the handled marker before flipping, records the evidence, and finalizes', async () => {
    const { d, calls } = deps([est({ PrivateNote: 'old note' })]);
    const s = await syncBookedEstimates(d, [ev({ summary: 'Arthur Downey' })]);
    expect(s).toMatchObject({ jobs: 1, accepted: 1 });
    expect(calls).toEqual(['handled:e1:booking-sync:ev-1', 'update:e1', 'outcome:ev-1:accepted:e1:true']);
    const [, update] = vi.mocked(d.qb.updateEstimate).mock.calls[0];
    expect(update.txnStatus).toBe('Accepted');
    expect(update.privateNote).toMatch(/^Accepted by booking sync: "Arthur Downey" on 2026-11-12 .*matched by name\)\.\nold note$/);
  });

  it('a multi-day job accepts once; the second day is covered', async () => {
    const { d } = deps([est()]);
    const s = await syncBookedEstimates(d, [
      ev({ summary: 'Arthur Downey' }),
      ev({ id: 'ev-2', summary: 'Arthur Downey [cont]', start: '2026-11-13T13:00:00Z' }),
    ]);
    expect(s).toMatchObject({ accepted: 1, covered: 1 });
    expect(d.qb.updateEstimate).toHaveBeenCalledTimes(1);
  });

  it('skips events with an outcome and loads nothing when all are settled', async () => {
    const { d } = deps([est()], { 'ev-1': 'accepted:e1' });
    const s = await syncBookedEstimates(d, [ev(), ev({ id: 'hold', colorId: '8' })]);
    expect(s).toMatchObject({ jobs: 1, accepted: 0 });
    expect(d.qb.listAllCustomers).not.toHaveBeenCalled();
  });

  it('records none/ambiguous as non-final and leaves QBO alone', async () => {
    const { d, calls } = deps([est(), est({ Id: 'e2' })]);
    const s = await syncBookedEstimates(d, [ev({ summary: 'Arthur Downey' })]);
    expect(s.ambiguous).toBe(1);
    expect(calls).toEqual(['outcome:ev-1:ambiguous:false']);
  });

  it('one failing event does not stop the rest', async () => {
    const { d } = deps([est()]);
    vi.mocked(d.qb.getEstimatesByCustomer).mockRejectedValueOnce(new Error('qbo 500'));
    const s = await syncBookedEstimates(d, [
      ev({ summary: 'Arthur Downey' }),
      ev({ id: 'ev-2', summary: 'Arthur Downey' }),
    ]);
    expect(s).toMatchObject({ errors: 1, accepted: 1 });
  });
});
