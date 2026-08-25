import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing handler
vi.mock('../lib/redis.js', () => ({
  markEventProcessed: vi.fn().mockResolvedValue(true),
  storeIdMapping: vi.fn().mockResolvedValue(undefined),
  getQuoIdFromPipedrive: vi.fn().mockResolvedValue(null),
  storePhoneMapping: vi.fn().mockResolvedValue(undefined),
  getQbCustomerIdFromPipedrive: vi.fn().mockResolvedValue(null),
  storePipedriveToQbMapping: vi.fn().mockResolvedValue(undefined),
  trackWebhookProcessed: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
  tryAcquireContactCreateLock: vi.fn().mockResolvedValue(true),
}));

const mockPipedrive = {
  searchPersonByPhone: vi.fn().mockResolvedValue(null),
  getPerson: vi.fn().mockResolvedValue(null),
  getOrganization: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({ id: 1, name: 'Test', phone: [], email: [] }),
  updatePerson: vi.fn().mockResolvedValue({ id: 1, name: 'Test', phone: [], email: [] }),
  logActivity: vi.fn().mockResolvedValue({ id: 1 }),
  createTask: vi.fn().mockResolvedValue({ id: 1 }),
  getPersonCustomField: vi.fn().mockResolvedValue(null),
  setPersonCustomField: vi.fn().mockResolvedValue(undefined),
};

const mockQuo = {
  findContactByExternalId: vi.fn().mockResolvedValue(null),
  createContact: vi.fn().mockResolvedValue({ id: 'quo-1', defaultFields: {} }),
  updateContact: vi.fn().mockResolvedValue({ id: 'quo-1', defaultFields: {} }),
  sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
};

const mockQuickBooks = {
  isConnected: vi.fn().mockResolvedValue(false),
  searchCustomerByEmail: vi.fn().mockResolvedValue(null),
  searchCustomerByName: vi.fn().mockResolvedValue(null),
  createCustomer: vi.fn().mockResolvedValue({ Id: 'qb-1', DisplayName: 'Test' }),
  getCustomer: vi.fn().mockResolvedValue(null),
  updateCustomer: vi.fn().mockResolvedValue({ Id: 'qb-1' }),
};

vi.mock('../lib/clients.js', () => ({
  getPipedrive: vi.fn(() => mockPipedrive),
  getQuo: vi.fn(() => mockQuo),
  getQuickBooks: vi.fn(() => mockQuickBooks),
  getGemini: vi.fn(() => ({ extractEntities: vi.fn().mockResolvedValue(null) })),
}));

import handler, { buildQbDisplayName, isQbErrorCode } from '../api/webhooks/pipedrive.js';
import { markEventProcessed, storePhoneMapping, trackWebhookProcessed } from '../lib/redis.js';

function makeReq(body: Record<string, unknown>, method = 'POST') {
  return { method, body } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      action: 'added',
      change_source: 'app',
      company_id: 1,
      host: 'test.pipedrive.com',
      id: 12345,
      object: 'person',
      timestamp: Date.now(),
      user_id: 1,
      webhook_id: 'wh-1',
    },
    data: {
      id: 100,
      name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      phones: [{ value: '+15551234567', primary: true, label: 'mobile' }],
      emails: [{ value: 'john@example.com', primary: true, label: 'work' }],
      org_id: null,
      org_name: null,
      owner_id: 1,
      ...overrides,
    },
    previous: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  (markEventProcessed as any).mockResolvedValue(true);
  const redis = await import('../lib/redis.js');
  (redis.tryAcquireContactCreateLock as any).mockResolvedValue(true);
  (redis.getQuoIdFromPipedrive as any).mockResolvedValue(null);
  mockQuo.findContactByExternalId.mockResolvedValue(null);
  mockQuo.createContact.mockResolvedValue({ id: 'quo-new', defaultFields: {} });
  mockQuickBooks.isConnected.mockResolvedValue(false);
});

describe('pipedrive webhook', () => {
  it('rejects non-POST requests', async () => {
    const res = makeRes();
    await handler(makeReq({}, 'GET'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('rejects invalid payload (no meta)', async () => {
    const res = makeRes();
    await handler(makeReq({ data: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('deduplicates events', async () => {
    (markEventProcessed as any).mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('duplicate');
  });

  it('skips persons with no phone', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload({ phones: [] })), res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('no_phone');
  });

  it('syncs new person to Quo', async () => {
    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(mockQuo.createContact).toHaveBeenCalledOnce();
    expect(storePhoneMapping).toHaveBeenCalledWith('+15551234567', '100');
    expect(trackWebhookProcessed).toHaveBeenCalledWith('pipedrive');

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('synced');
    expect(body.quoId).toBe('quo-new');
  });

  it('updates existing Quo contact when mapping exists in Redis', async () => {
    const { getQuoIdFromPipedrive } = await import('../lib/redis.js');
    (getQuoIdFromPipedrive as any).mockResolvedValue('quo-existing');

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(mockQuo.updateContact).toHaveBeenCalledOnce();
    expect(mockQuo.createContact).not.toHaveBeenCalled();
  });

  it('waits and re-searches when contact create lock is held', async () => {
    const { tryAcquireContactCreateLock, getQuoIdFromPipedrive } = await import('../lib/redis.js');
    (getQuoIdFromPipedrive as any).mockResolvedValue(null);
    (tryAcquireContactCreateLock as any).mockResolvedValue(false);
    // After waiting, the re-search should find the contact created by the other handler
    mockQuo.findContactByExternalId
      .mockResolvedValueOnce(null) // First lookup (before lock)
      .mockResolvedValueOnce({ id: 'quo-from-other', defaultFields: {} }); // Re-lookup after wait

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(mockQuo.createContact).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('synced');
    expect(body.quoId).toBe('quo-from-other');
  }, 10000);

  it('returns 200 even when Quo sync fails (fail safe)', async () => {
    mockQuo.createContact.mockRejectedValue(new Error('API down'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    // Should still return 200 — fail safe
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('logs a health error when Quo sync fails so error-surface can page', async () => {
    mockQuo.createContact.mockRejectedValue(new Error('API down'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const redis = await import('../lib/redis.js');
    expect(redis.logHealthError).toHaveBeenCalledWith(
      'pipedrive',
      expect.stringContaining('Quo sync failed: API down'),
      expect.objectContaining({ pipedriveId: '100' })
    );
  });

  it('logs a health error when QuickBooks sync fails so error-surface can page', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    mockQuickBooks.createCustomer.mockRejectedValueOnce(new Error('QB down'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const redis = await import('../lib/redis.js');
    expect(redis.logHealthError).toHaveBeenCalledWith(
      'pipedrive',
      expect.stringContaining('QuickBooks sync failed: QB down'),
      expect.objectContaining({ pipedriveId: '100' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  const qbFault = (code: string) =>
    new Error(
      `QuickBooks API error: 400 - {"Fault":{"Error":[{"Message":"x","Detail":"x","code":"${code}"}],"type":"ValidationFault"}}`
    );

  it('recovers from duplicate-name (6240) create race by linking the winner', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    mockQuickBooks.createCustomer.mockRejectedValueOnce(qbFault('6240'));
    // First search (pre-create) misses; recovery search finds the winner
    mockQuickBooks.searchCustomerByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Id: 'qb-winner', DisplayName: 'John Doe', Active: true });

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const redis = await import('../lib/redis.js');
    expect(mockQuickBooks.searchCustomerByName).toHaveBeenLastCalledWith(
      expect.any(String),
      { includeInactive: true }
    );
    expect(redis.storePipedriveToQbMapping).toHaveBeenCalledWith('100', 'qb-winner');
    expect(mockQuickBooks.updateCustomer).not.toHaveBeenCalled();
    expect(redis.logHealthError).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reactivates an inactive customer when 6240 collides with a deactivated name', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    mockQuickBooks.createCustomer.mockRejectedValueOnce(qbFault('6240'));
    mockQuickBooks.searchCustomerByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        Id: 'qb-inactive',
        DisplayName: 'John Doe',
        Active: false,
        SyncToken: '3',
      });

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const redis = await import('../lib/redis.js');
    expect(mockQuickBooks.updateCustomer).toHaveBeenCalledWith(
      'qb-inactive',
      expect.objectContaining({ Active: true, SyncToken: '3' })
    );
    expect(redis.storePipedriveToQbMapping).toHaveBeenCalledWith('100', 'qb-inactive');
    expect(redis.logHealthError).not.toHaveBeenCalled();
  });

  it('still logs a health error when 6240 recovery search finds nothing', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    mockQuickBooks.createCustomer.mockRejectedValueOnce(qbFault('6240'));
    mockQuickBooks.searchCustomerByName.mockResolvedValue(null);

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    const redis = await import('../lib/redis.js');
    expect(redis.logHealthError).toHaveBeenCalledWith(
      'pipedrive',
      expect.stringContaining('6240'),
      expect.objectContaining({ pipedriveId: '100' })
    );
  });

  it('treats stale-object (5010) update rejection as success', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    const redis = await import('../lib/redis.js');
    (redis.getQbCustomerIdFromPipedrive as any).mockResolvedValueOnce('qb-1');
    mockQuickBooks.getCustomer.mockResolvedValueOnce({
      Id: 'qb-1',
      DisplayName: 'John Doe',
      SyncToken: '2',
    });
    mockQuickBooks.updateCustomer.mockRejectedValueOnce(qbFault('5010'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(redis.logHealthError).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still surfaces non-5010 update failures', async () => {
    mockQuickBooks.isConnected.mockResolvedValue(true);
    const redis = await import('../lib/redis.js');
    (redis.getQbCustomerIdFromPipedrive as any).mockResolvedValueOnce('qb-1');
    mockQuickBooks.getCustomer.mockResolvedValueOnce({
      Id: 'qb-1',
      DisplayName: 'John Doe',
      SyncToken: '2',
    });
    mockQuickBooks.updateCustomer.mockRejectedValueOnce(qbFault('2020'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    expect(redis.logHealthError).toHaveBeenCalledWith(
      'pipedrive',
      expect.stringContaining('QuickBooks sync failed'),
      expect.objectContaining({ pipedriveId: '100' })
    );
  });
});

describe('isQbErrorCode', () => {
  it('matches the structured fault code in the message', () => {
    const err = new Error(
      'QuickBooks API error: 400 - {"Fault":{"Error":[{"Message":"Duplicate Name Exists Error","code":"6240"}]}}'
    );
    expect(isQbErrorCode(err, '6240')).toBe(true);
    expect(isQbErrorCode(err, '5010')).toBe(false);
  });

  it('rejects non-Error values and unrelated messages', () => {
    expect(isQbErrorCode('6240', '6240')).toBe(false);
    expect(isQbErrorCode(new Error('code 6240 somewhere'), '6240')).toBe(false);
  });
});

describe('buildQbDisplayName', () => {
  const phone = '+19087459554';

  it('returns the name as-is when it has 2+ tokens', () => {
    expect(buildQbDisplayName('Sam Sabky', phone)).toBe('Sam Sabky');
    expect(buildQbDisplayName('Sam J Sabky', phone)).toBe('Sam J Sabky');
  });

  it('appends phone-last-4 disambiguator for single-token names', () => {
    expect(buildQbDisplayName('Sam', phone)).toBe('Sam (·9554)');
    expect(buildQbDisplayName('Tom', '+15558675309')).toBe('Tom (·5309)');
  });

  it('uses "Lead (·xxxx)" when no usable name has been extracted', () => {
    expect(buildQbDisplayName('', phone)).toBe('Lead (·9554)');
    expect(buildQbDisplayName('Unknown', phone)).toBe('Lead (·9554)');
    expect(buildQbDisplayName('Unknown Lead 5478', phone)).toBe('Lead (·9554)');
  });

  it('trims whitespace before deciding token count', () => {
    expect(buildQbDisplayName('  Sam  ', phone)).toBe('Sam (·9554)');
    expect(buildQbDisplayName('  Sam Sabky  ', phone)).toBe('Sam Sabky');
  });
});
