import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListEvents = vi.fn();
const mockSearchPersonByName = vi.fn();
const mockGetPerson = vi.fn();
const mockSearchCustomerByEmail = vi.fn();
const mockSearchCustomerByName = vi.fn();
const mockGetInvoicesByCustomer = vi.fn();
const mockGetEstimatesByCustomer = vi.fn();
const mockCreateInvoiceFromEstimate = vi.fn();
const mockSendMessage = vi.fn();

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
    getEstimatesByCustomer: mockGetEstimatesByCustomer,
    createInvoiceFromEstimate: mockCreateInvoiceFromEstimate,
  }),
  getQuo: () => ({ sendMessage: mockSendMessage }),
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

vi.mock('../lib/cron.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/cron.js')>('../lib/cron.js');
  return { ...actual, verifyCronAuth: () => true };
});

vi.mock('../lib/redis.js', () => ({
  markCronAction: vi.fn().mockResolvedValue(true),
  trackCronRun: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../api/cron/invoice-create.js';

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
  start: '2026-05-18T08:00:00-04:00',
  end: '2026-05-18T12:00:00-04:00',
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
  mockGetEstimatesByCustomer.mockResolvedValue([]);
  mockCreateInvoiceFromEstimate.mockResolvedValue({ Id: 'qb-i-99', TotalAmt: 1500 });
  mockSendMessage.mockResolvedValue({ id: 'm' });
});

describe('cron/invoice-create', () => {
  it('returns 405 for non-GET', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns empty when no events', async () => {
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.summary.totalEvents).toBe(0);
  });

  it('creates an invoice from the single accepted estimate', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.summary.created).toBe(1);
    expect(body.results[0].status).toBe('created');
    expect(body.results[0].invoiceId).toBe('qb-i-99');
    expect(mockCreateInvoiceFromEstimate).toHaveBeenCalledWith('qb-e-7');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('dry run does NOT call createInvoiceFromEstimate', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.dryRun).toBe(true);
    expect(body.results[0].status).toBe('created');
    expect(body.results[0].estimateId).toBe('qb-e-7');
    expect(mockCreateInvoiceFromEstimate).not.toHaveBeenCalled();
  });

  it('skips when no Pipedrive person matched', async () => {
    mockListEvents.mockResolvedValue([event]);
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);
    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_no_person');
  });

  it('skips when no QB customer matched', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);
    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_no_qb_customer');
  });

  it('skips when no accepted estimate exists', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([]);
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);
    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_no_accepted_estimate');
  });

  it('skips + alerts Matt by SMS when multiple accepted estimates exist', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([
      { Id: 'qb-e-7', DocNumber: '1001', TotalAmt: 1500 },
      { Id: 'qb-e-8', DocNumber: '1002', TotalAmt: 4200 },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.results[0].status).toBe('skipped_multi_accepted_estimate');
    expect(mockCreateInvoiceFromEstimate).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [phone, message] = mockSendMessage.mock.calls[0];
    expect(phone).toBe('+15551112222');
    expect(message).toContain('multiple accepted estimates');
    expect(message).toContain('John Smith');
    expect(message).toContain('1001');
    expect(message).toContain('1002');
  });

  it('does NOT send the alert SMS during a dry run', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([
      { Id: 'qb-e-7', TotalAmt: 1500 },
      { Id: 'qb-e-8', TotalAmt: 4200 },
    ]);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_multi_accepted_estimate');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('skips when an invoice already exists for this customer in the last 24h', async () => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetInvoicesByCustomer.mockResolvedValue([{ Id: 'qb-i-prev', Balance: 1500 }]);
    mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.results[0].status).toBe('skipped_existing_invoice');
    expect(body.results[0].invoiceId).toBe('qb-i-prev');
    expect(mockCreateInvoiceFromEstimate).not.toHaveBeenCalled();
  });
});
