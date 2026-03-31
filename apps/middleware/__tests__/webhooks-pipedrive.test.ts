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
  searchContactByPhone: vi.fn().mockResolvedValue(null),
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

import handler from '../api/webhooks/pipedrive.js';
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

beforeEach(() => {
  vi.clearAllMocks();
  (markEventProcessed as any).mockResolvedValue(true);
  mockQuo.searchContactByPhone.mockResolvedValue(null);
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

  it('returns 200 even when Quo sync fails (fail safe)', async () => {
    mockQuo.createContact.mockRejectedValue(new Error('API down'));

    const res = makeRes();
    await handler(makeReq(makePayload()), res);

    // Should still return 200 — fail safe
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
