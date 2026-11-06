import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListEvents = vi.fn();
const mockSearchPersonByName = vi.fn();
const mockGetPerson = vi.fn();
const mockGetDeal = vi.fn();
const mockSearchCustomerByEmail = vi.fn();
const mockSearchCustomerByName = vi.fn();
const mockGetInvoicesByCustomer = vi.fn();
const mockGetEstimate = vi.fn();
const mockGetEstimatesByCustomer = vi.fn();
const mockCreateInvoiceFromEstimate = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getCalendar: () => ({ listEvents: mockListEvents }),
  getPipedrive: () => ({
    searchPersonByName: mockSearchPersonByName,
    getPerson: mockGetPerson,
    getDeal: mockGetDeal,
  }),
  getQuickBooks: () => ({
    searchCustomerByEmail: mockSearchCustomerByEmail,
    searchCustomerByName: mockSearchCustomerByName,
    getInvoicesByCustomer: mockGetInvoicesByCustomer,
    getEstimate: mockGetEstimate,
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
  releaseCronAction: vi.fn().mockResolvedValue(undefined),
  trackCronRun: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
  countCondition: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../api/cron/invoice-create.js';
import { VendorHttpError } from '@aac/api-clients/errors';
import { countCondition, logHealthError, markCronAction, releaseCronAction } from '../lib/redis.js';

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
  mockGetDeal.mockResolvedValue(null);
  mockSearchCustomerByEmail.mockResolvedValue(null);
  mockSearchCustomerByName.mockResolvedValue(null);
  mockGetInvoicesByCustomer.mockResolvedValue([]);
  mockGetEstimate.mockResolvedValue(null);
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

  describe('jobs not invoiced are counted with the job (System health)', () => {
    const entity = { id: 'evt-1', label: 'John Smith · 123 Main St, Boston, MA · 2026-05-18' };

    it('no Pipedrive person → invoice-create.no_person (label falls back to the event title)', async () => {
      mockListEvents.mockResolvedValue([event]);
      await handler(makeReq(), makeRes());
      expect(countCondition).toHaveBeenCalledWith('invoice-create.no_person', { entity });
    });

    it('no QB customer → invoice-create.no_qb_customer', async () => {
      mockListEvents.mockResolvedValue([event]);
      mockSearchPersonByName.mockResolvedValue({ id: 1 });
      mockGetPerson.mockResolvedValue(person);
      await handler(makeReq(), makeRes());
      expect(countCondition).toHaveBeenCalledWith('invoice-create.no_qb_customer', { entity });
    });

    it('no accepted estimate → invoice-create.no_accepted_estimate', async () => {
      mockListEvents.mockResolvedValue([event]);
      mockSearchPersonByName.mockResolvedValue({ id: 1 });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      await handler(makeReq(), makeRes());
      expect(countCondition).toHaveBeenCalledWith('invoice-create.no_accepted_estimate', { entity });
    });

    it('several accepted estimates → invoice-create.multi_accepted_estimate', async () => {
      mockListEvents.mockResolvedValue([event]);
      mockSearchPersonByName.mockResolvedValue({ id: 1 });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'a' }, { Id: 'b' }]);
      await handler(makeReq(), makeRes());
      expect(countCondition).toHaveBeenCalledWith('invoice-create.multi_accepted_estimate', { entity });
    });

    it('a created invoice and a dry run count nothing', async () => {
      mockListEvents.mockResolvedValue([event]);
      mockSearchPersonByName.mockResolvedValue({ id: 1 });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);
      await handler(makeReq(), makeRes());
      mockGetEstimatesByCustomer.mockResolvedValue([]);
      await handler(makeReq({ dry: 'true' }), makeRes());
      expect(countCondition).not.toHaveBeenCalled();
    });
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

  describe('deal marker fast path', () => {
    const markedEvent = { ...event, description: 'Repair details [deal:42]' };

    it('uses deal.qbEstimateId directly and skips the estimate search', async () => {
      mockListEvents.mockResolvedValue([markedEvent]);
      mockGetDeal.mockResolvedValue({
        id: 42, personId: 1, qbEstimateId: 'qb-est-deal-7', stage: 'job_scheduled',
      });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      mockGetEstimate.mockResolvedValue({ Id: 'qb-est-deal-7', TotalAmt: 2200 });

      const res = makeRes();
      await handler(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect(body.results[0].status).toBe('created');
      expect(body.results[0].estimateId).toBe('qb-est-deal-7');
      expect(mockGetEstimate).toHaveBeenCalledWith('qb-est-deal-7');
      // The customer-wide search must NOT run when the deal already named the estimate
      expect(mockGetEstimatesByCustomer).not.toHaveBeenCalled();
      // And we don't touch name-match either
      expect(mockSearchPersonByName).not.toHaveBeenCalled();
    });

    it('skips both the multi-estimate alert AND the no-estimate skip when deal pins the estimate', async () => {
      // The customer has multiple accepted estimates — without the deal marker
      // this would trigger the multi-estimate alert SMS. With the marker, we
      // bypass that whole check.
      mockListEvents.mockResolvedValue([markedEvent]);
      mockGetDeal.mockResolvedValue({
        id: 42, personId: 1, qbEstimateId: 'qb-est-deal-7', stage: 'job_scheduled',
      });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      mockGetEstimate.mockResolvedValue({ Id: 'qb-est-deal-7', TotalAmt: 2200 });
      mockGetEstimatesByCustomer.mockResolvedValue([
        { Id: 'qb-e-a', TotalAmt: 1000 },
        { Id: 'qb-e-b', TotalAmt: 2200 },
      ]);

      const res = makeRes();
      await handler(makeReq(), res);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockGetEstimatesByCustomer).not.toHaveBeenCalled();
    });

    it('falls back to the customer-wide estimate search when the deal references a missing estimate', async () => {
      mockListEvents.mockResolvedValue([markedEvent]);
      mockGetDeal.mockResolvedValue({
        id: 42, personId: 1, qbEstimateId: 'qb-est-gone', stage: 'job_scheduled',
      });
      mockGetPerson.mockResolvedValue(person);
      mockSearchCustomerByEmail.mockResolvedValue(customer);
      mockGetEstimate.mockResolvedValue(null); // missing
      mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);

      const res = makeRes();
      await handler(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect(body.results[0].status).toBe('created');
      expect(body.results[0].estimateId).toBe('qb-e-7');
      expect(mockGetEstimatesByCustomer).toHaveBeenCalled();
    });
  });
});

describe('cron/invoice-create: marker on a failed create (owner policy 2026-11-05)', () => {
  beforeEach(() => {
    mockListEvents.mockResolvedValue([event]);
    mockSearchPersonByName.mockResolvedValue({ id: 1 });
    mockGetPerson.mockResolvedValue(person);
    mockSearchCustomerByEmail.mockResolvedValue(customer);
    mockGetEstimatesByCustomer.mockResolvedValue([{ Id: 'qb-e-7', TotalAmt: 1500 }]);
  });

  it('QuickBooks answers 500: marker released so the next run retries', async () => {
    mockCreateInvoiceFromEstimate.mockRejectedValueOnce(
      new VendorHttpError('quickbooks', 500, 'QuickBooks API error: 500 - boom'),
    );
    const res = makeRes();
    await handler(makeReq(), res);

    expect(markCronAction).toHaveBeenCalledWith('invoice-create', 'evt-1');
    expect(releaseCronAction).toHaveBeenCalledWith('invoice-create', 'evt-1');
    expect(res.json.mock.calls[0][0].results[0].status).toBe('error');
    expect(logHealthError).toHaveBeenCalledWith(
      'cron:invoice-create',
      expect.stringContaining('marker released, next run retries'),
    );
  });

  it('network error: marker kept, health error logged', async () => {
    mockCreateInvoiceFromEstimate.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(releaseCronAction).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].status).toBe('error');
    expect(logHealthError).toHaveBeenCalledWith(
      'cron:invoice-create',
      expect.stringContaining('marker kept, NOT retried'),
    );
  });

  it('a failure before the create (lookup) does not release the marker', async () => {
    mockGetEstimatesByCustomer.mockRejectedValueOnce(
      new VendorHttpError('quickbooks', 500, 'QuickBooks API error: 500 - boom'),
    );
    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreateInvoiceFromEstimate).not.toHaveBeenCalled();
    expect(releaseCronAction).not.toHaveBeenCalled();
  });

  it('success: marker kept', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    expect(releaseCronAction).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].status).toBe('created');
  });
});
