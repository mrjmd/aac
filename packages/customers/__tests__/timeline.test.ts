import { describe, it, expect, vi } from 'vitest';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBCustomer, QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import {
  buildCustomerTimeline,
  customerProfile,
  eventMatch,
  fetchEmailPart,
  fetchQboPart,
  fetchQuoPart,
  searchCustomers,
  trimCustomer,
  trimEvent,
} from '../src/index.js';

const customer: QBCustomer & { Id: string } = {
  Id: '3771',
  DisplayName: 'Jill Fairweather',
  PrimaryPhone: { FreeFormNumber: '(617) 555-0101' },
  Mobile: { FreeFormNumber: '617.555.0101' },
  PrimaryEmailAddr: { Address: 'Jill@Example.com, jill.work@example.com' },
  BillAddr: { Line1: '39 Hobart Lane Unit 39', City: 'Hingham', CountrySubDivisionCode: 'MA' },
};

let n = 0;
function ev(over: Partial<CalendarEvent>): CalendarEvent {
  return { id: `e${++n}`, summary: '', start: '2026-11-10T13:00:00Z', end: '2026-11-10T16:00:00Z', attendees: [], htmlLink: 'https://cal/x', attachments: [], ...over };
}
const est = (over: Partial<QBEstimate>): QBEstimate => ({ Id: 'q', SyncToken: '0', CustomerRef: { value: '3771' }, Line: [], ...over });
const inv = (over: Partial<QBInvoice>): QBInvoice => ({ Id: 'i', SyncToken: '0', CustomerRef: { value: '3771' }, Line: [], ...over });

describe('customerProfile', () => {
  it('de-duplicates phones and splits multi-address email fields', () => {
    const p = customerProfile(customer);
    expect(p.phones).toEqual(['+16175550101']);
    expect(p.emails).toEqual(['jill@example.com', 'jill.work@example.com']);
    expect(p.streetKey).toBe('39|hobart|39');
    expect(p.address).toBe('39 Hobart Lane Unit 39, Hingham, MA');
  });
});

describe('eventMatch', () => {
  const p = customerProfile(customer);
  it('matches by address even when the title names someone else', () => {
    expect(eventMatch(ev({ summary: 'Job - Rachel Baker', location: '39 Hobart Ln, Hingham MA' }), p)).toBe('address');
  });
  it('matches by phone in the description', () => {
    expect(eventMatch(ev({ summary: 'STUB — J', description: 'Customer phone: 617-555-0101' }), p)).toBe('phone');
  });
  it('matches by surname when the event has no address', () => {
    expect(eventMatch(ev({ summary: 'Assessment - Jill Fairwether' }), p)).toBe('name');
  });
  it('rejects a surname match at a different address', () => {
    expect(eventMatch(ev({ summary: 'Job - Bob Fairweather', location: '12 Oak Street, Quincy' }), p)).toBeNull();
  });
});

describe('buildCustomerTimeline', () => {
  const t = buildCustomerTimeline({
    customer,
    estimates: [
      est({ Id: '1', DocNumber: '1587', TxnDate: '2026-11-03', TotalAmt: 1550, TxnStatus: 'Pending' }),
      est({ Id: '2', DocNumber: '1400', TxnDate: '2026-05-01', TotalAmt: 900, TxnStatus: 'Accepted' }),
    ],
    invoices: [
      inv({ Id: '9', DocNumber: '2001', TxnDate: '2026-05-20', TotalAmt: 900, Balance: 300, DueDate: '2026-06-20' }),
    ],
    payments: [{ Id: 'p1', SyncToken: '0', TxnDate: '2026-05-25', TotalAmt: 600, CustomerRef: { value: '3771' }, PaymentRefNum: '1042' }],
    messages: [
      { id: 'm1', to: ['+16175550101'], from: '+16176681677', text: 'Quote sent', phoneNumberId: 'PN', direction: 'outgoing', status: 'delivered', createdAt: '2026-11-03T15:00:00Z', updatedAt: '' },
    ],
    calls: [
      { id: 'c1', to: '+16176681677', from: '+16175550101', phoneNumberId: 'PN', direction: 'incoming', status: 'completed', duration: 250, createdAt: '2026-11-01T14:00:00Z' },
      { id: 'c2', to: '+16176681677', from: '+16175550101', phoneNumberId: 'PN', direction: 'incoming', status: 'missed', createdAt: '2026-10-31T14:00:00Z' },
    ],
    emails: [
      { id: 'g1', threadId: 't1', from: 'Jill <jill@example.com>', fromAddress: 'jill@example.com', to: [], subject: 'Crack photos', at: '2026-10-30T12:00:00Z', labelIds: [], snippet: 'here they are', body: '', attachmentNames: [], attachments: [] },
    ],
    events: [
      ev({ id: 'v1', summary: 'Job - Jill Fairweather', start: '2026-11-20T13:00:00Z', end: '2026-11-20T17:00:00Z', colorId: '10' }),
      ev({ id: 'v2', summary: 'Job - Unrelated Person', location: '1 Main Street, Quincy' }),
    ],
    today: '2026-11-03',
    now: new Date('2026-11-03T18:00:00Z'),
  });

  it('merges every source newest first and skips unmatched events', () => {
    expect(t.entries.map((e) => e.id)).toEqual([
      'visit:v1', 'text:m1', 'quote:1', 'call:c1', 'call:c2', 'email:g1', 'payment:p1', 'invoice:9', 'quote:2',
    ]);
  });
  it('labels calls and emails from the customer side', () => {
    const byId = Object.fromEntries(t.entries.map((e) => [e.id, e]));
    expect(byId['call:c1'].title).toBe('Call from customer (4 min)');
    expect(byId['call:c2'].title).toBe('Missed call from customer');
    expect(byId['email:g1'].direction).toBe('in');
    expect(byId['invoice:9'].status).toBe('overdue');
  });
  it('totals money and picks last contact + next visit', () => {
    expect(t.totals).toEqual({ openQuotes: 1550, acceptedQuotes: 900, invoiced: 900, paid: 600, openBalance: 300, overdueBalance: 300 });
    expect(t.lastContact?.id).toBe('text:m1');
    expect(t.nextVisit?.id).toBe('visit:v1');
  });
});

describe('fetch parts', () => {
  it('fetchQboPart returns null for an unknown customer', async () => {
    const qb = {
      getCustomer: vi.fn().mockResolvedValue(null),
      getEstimatesByCustomer: vi.fn().mockResolvedValue([]),
      getInvoicesByCustomer: vi.fn().mockResolvedValue([]),
      getPayment: vi.fn(),
    };
    expect(await fetchQboPart(qb, '1')).toBeNull();
  });
  it('fetchQboPart loads the payments linked from invoices once each', async () => {
    const qb = {
      getCustomer: vi.fn().mockResolvedValue(customer),
      getEstimatesByCustomer: vi.fn().mockResolvedValue([]),
      getInvoicesByCustomer: vi.fn().mockResolvedValue([
        inv({ Id: '1', LinkedTxn: [{ TxnId: 'p1', TxnType: 'Payment' }, { TxnId: 'e1', TxnType: 'Estimate' }] }),
        inv({ Id: '2', LinkedTxn: [{ TxnId: 'p1', TxnType: 'Payment' }] }),
      ]),
      getPayment: vi.fn().mockResolvedValue({ Id: 'p1', SyncToken: '0', TotalAmt: 5, CustomerRef: { value: '3771' } }),
    };
    const part = await fetchQboPart(qb, '3771');
    expect(qb.getPayment).toHaveBeenCalledTimes(1);
    expect(part?.payments).toHaveLength(1);
  });
  it('fetchQuoPart pages through texts for each number', async () => {
    const quo = {
      listMessages: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ id: 'a' }], nextPageToken: 'n' })
        .mockResolvedValueOnce({ data: [{ id: 'b' }] }),
      listCalls: vi.fn().mockResolvedValue({ data: [] }),
    };
    const part = await fetchQuoPart(quo, ['+16175550101']);
    expect(part.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(quo.listMessages.mock.calls[1][0].pageToken).toBe('n');
  });
  it('fetchEmailPart searches every address and drops bodies', async () => {
    const gmail = {
      listMessages: vi.fn().mockResolvedValue([
        { id: 'g', threadId: 't', from: 'J', fromAddress: 'jill@example.com', to: [], subject: 's', at: 'x', labelIds: [], snippet: 'sn', body: 'long body', attachmentNames: [], attachments: [] },
      ]),
    };
    const out = await fetchEmailPart(gmail, ['jill@example.com', 'jill.work@example.com']);
    expect(gmail.listMessages.mock.calls[0][0].query).toBe(
      '{from:jill@example.com to:jill@example.com cc:jill@example.com from:jill.work@example.com to:jill.work@example.com cc:jill.work@example.com} -in:spam -in:trash',
    );
    expect(out).toEqual([{ id: 'g', threadId: 't', fromAddress: 'jill@example.com', subject: 's', at: 'x', snippet: 'sn' }]);
    expect(await fetchEmailPart(gmail, [])).toEqual([]);
  });
  it('trimEvent keeps only phone numbers from the description, and still matches by phone', () => {
    const t = trimEvent(ev({ summary: 'STUB — J', description: 'Long notes...\nCustomer phone: 617-555-0101\nGate code 1234' }));
    expect(t.description).toBe('617-555-0101');
    expect(eventMatch(t, customerProfile(customer))).toBe('phone');
    expect(trimEvent(ev({ description: 'no phone here' })).description).toBeUndefined();
  });
});

describe('searchCustomers', () => {
  const all: QBCustomer[] = [
    customer,
    { Id: '2', DisplayName: 'Champion Builders', CompanyName: 'Champion Builders', PrimaryPhone: { FreeFormNumber: '781-555-2222' } },
    { Id: '3', DisplayName: 'Tom Dacey', CompanyName: 'Champion Builders', Active: false },
  ];
  it('finds by phone in any format', () => {
    expect(searchCustomers(all, '6175550101').map((h) => h.id)).toEqual(['3771']);
  });
  it('finds by typo-tolerant name and by company', () => {
    expect(searchCustomers(all, 'fairwether')[0]?.id).toBe('3771');
    expect(searchCustomers(all, 'champion').map((h) => h.id)).toEqual(['2', '3']);
  });
  it('trimCustomer keeps what search needs', () => {
    const t = trimCustomer({ ...customer, SyncToken: '9' });
    expect(t.SyncToken).toBeUndefined();
    expect(searchCustomers([t], '6175550101')).toHaveLength(1);
  });
  it('finds by address', () => {
    expect(searchCustomers(all, '39 hobart')[0]?.matchedBy).toBe('address');
  });
});
