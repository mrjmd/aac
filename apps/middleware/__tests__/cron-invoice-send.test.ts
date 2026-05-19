import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListEvents = vi.fn();
const mockSearchPersonByName = vi.fn();
const mockGetPerson = vi.fn();
const mockSearchCustomerByEmail = vi.fn();
const mockSearchCustomerByName = vi.fn();
const mockGetInvoicesByCustomer = vi.fn();
const mockSendInvoice = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getCalendar: () => ({ listEvents: mockListEvents }),
  getPipedrive: () => ({
    searchPersonByName: mockSearchPersonByName,
    getPerson: mockGetPerson,
  }),
  getQuickBooks: () => ({
    searchCustomerByEmail: mockSearchCustomerByEmail,
    searchCustomerByName: mockSearchCustomerByName,
    getInvoicesByCustomer: mockGetInvoicesByCustomer,
    sendInvoice: mockSendInvoice,
  }),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    google: {
      technicianEmails: ['mike@attackacrack.com'],
      calendarId: 'matt@attackacrack.com',
    },
    notifications: { alertPhoneNumber: '+15551112222' },
    cron: { secret: 'test-secret' },
    nodeEnv: 'development',
  }),
}));

vi.mock('../lib/cron.js', () => ({ verifyCronAuth: () => true }));

vi.mock('../lib/redis.js', () => ({
  markCronAction: vi.fn().mockResolvedValue(true),
  trackCronRun: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../api/cron/invoice-send.js';

function makeReq(query: Record<string, string> = {}) {
  return { method: 'GET', query, headers: { authorization: 'Bearer test-secret' } } as any;
}
function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const event = {
  id: 'evt-1',
  summary: 'John Smith',
  location: '123 Main St, Boston, MA',
  description: 'Foundation crack repair',
  start: '2026-05-16T08:00:00-04:00',
  end: '2026-05-16T12:00:00-04:00',
  colorId: '10',
  attendees: ['mike@attackacrack.com'],
  htmlLink: '',
  attachments: [],
};

const person = { id: 1, name: 'John Smith', phone: [], email: [{ value: 'john@example.com', primary: true }] };
const customer = { Id: 'qb-c-1', DisplayName: 'John Smith' };

beforeEach(() => {
  vi.clearAllMocks();
  mockListEvents.mockResolvedValue([]);
  mockSearchPersonByName.mockResolvedValue(null);
  mockGetPerson.mockResolvedValue(null);
  mockSearchCustomerByEmail.mockResolvedValue(null);
  mockSearchCustomerByName.mockResolvedValue(null);
  mockGetInvoicesByCustomer.mockResolvedValue([]);
  mockSendInvoice.mockResolvedValue({ Id: 'inv-1', EmailStatus: 'EmailSent' });
});

describe('cron/invoice-send', () => {
  it('returns 405 for non-GET', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('sends an unpaid, unsent invoice', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([
      { Id: 'inv-1', Balance: 1500, EmailStatus: 'NeedToSend' },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockSendInvoice).toHaveBeenCalledWith('inv-1');
    expect(res.json.mock.calls[0][0].results[0].status).toBe('sent');
  });

  it('dry run does NOT call sendInvoice', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([
      { Id: 'inv-1', Balance: 1500, EmailStatus: 'NeedToSend' },
    ]);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(mockSendInvoice).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].status).toBe('sent');
  });

  it('skips paid invoices', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([
      { Id: 'inv-1', Balance: 0, EmailStatus: 'NeedToSend' },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockSendInvoice).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_paid');
  });

  it('skips invoices already emailed', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([
      { Id: 'inv-1', Balance: 1500, EmailStatus: 'EmailSent' },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockSendInvoice).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_already_sent');
  });

  it('skips when no invoice in lookback window', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_no_invoice');
  });

  it('honors delay= override', async () => {
    const res = makeRes();
    await handler(makeReq({ dry: 'true', delay: '3' }), res);
    expect(res.json.mock.calls[0][0].delayDays).toBe(3);
  });
});
