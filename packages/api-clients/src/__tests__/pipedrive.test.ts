import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PipedriveClient,
  PIPEDRIVE_CROSS_SYSTEM_FIELDS,
  shouldUpdateName,
  isNameRefinement,
  type PipedriveDealSpineConfig,
} from '../pipedrive.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient() {
  return new PipedriveClient({
    apiKey: 'test-api-key',
    companyDomain: 'testcompany',
    systemUserId: 'system-1',
  });
}

function mockResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('PipedriveClient', () => {
  describe('searchPersonByPhone', () => {
    it('finds a person by phone', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        items: [{ item: { id: 1, name: 'John Doe', phone: [{ value: '+15551234567', primary: true }], email: [] } }],
      }));

      const result = await client.searchPersonByPhone('+15551234567');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toContain('api_token=test-api-key');
    });

    it('returns null when no match found', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ items: [] }));

      const result = await client.searchPersonByPhone('+15559999999');
      expect(result).toBeNull();
    });
  });

  describe('createPerson', () => {
    it('creates a person with name and phone', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 2, name: 'Jane Doe', phone: [], email: [] }));

      const result = await client.createPerson('Jane Doe', '+15551234567');
      expect(result.id).toBe(2);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('Jane Doe');
      expect(body.phone[0].value).toBe('+15551234567');
    });

    it('creates a person with email and note', async () => {
      const client = makeClient();
      // First call: create person. Second call: create note.
      mockFetch.mockReturnValueOnce(mockResponse({ id: 3, name: 'With Note', phone: [], email: [] }));
      mockFetch.mockReturnValueOnce(mockResponse({ id: 1 }));

      await client.createPerson('With Note', '+15551234567', {
        email: 'test@example.com',
        note: 'Lead source: Google Ads',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const noteBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(noteBody.content).toBe('Lead source: Google Ads');
      expect(noteBody.person_id).toBe(3);
    });
  });

  describe('logActivity', () => {
    it('logs an activity with correct type and duration format', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 10, type: 'call', subject: 'Test', person_id: 1, done: true }));

      const result = await client.logActivity(1, 'call', { subject: 'Inbound call', duration: 120 });
      expect(result.id).toBe(10);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('call');
      expect(body.person_id).toBe(1);
      expect(body.duration).toBe('00:02'); // 120 seconds = HH:MM format
      expect(body.done).toBe(true);
    });

    it('always sends type call even when passed sms', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 12, type: 'call', subject: 'SMS', person_id: 1, done: true }));

      await client.logActivity(1, 'sms', { subject: 'SMS Received: "hello"' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('call'); // Pipedrive has no native sms type
    });

    it('omits duration when zero or undefined', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 13, type: 'call', subject: 'Test', person_id: 1, done: true }));

      await client.logActivity(1, 'call', { subject: 'Inbound call' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.duration).toBeUndefined();
    });
  });

  describe('createTask', () => {
    it('creates an undone task', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 11, type: 'task', subject: 'Follow up', person_id: 1, done: false }));

      const result = await client.createTask(1, 'Follow up', 'Call them back');
      expect(result.done).toBe(false);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.done).toBe(false);
      expect(body.type).toBe('task');
    });
  });

  describe('listActivities', () => {
    it('lists activities with filters', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse([
        {
          id: 20, type: 'call', subject: 'Inbound Call (2m 30s)',
          person_id: 1, done: true, add_time: '2026-04-01 14:30:00',
          duration: '00:02:30', note: 'Inbound call', due_date: null, due_time: null,
        },
      ]));

      const result = await client.listActivities({
        type: 'call',
        startDate: '2026-03-15',
        endDate: '2026-04-01',
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('call');
      expect(result[0].add_time).toBe('2026-04-01 14:30:00');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('type=call');
      expect(url).toContain('start_date=2026-03-15');
      expect(url).toContain('end_date=2026-04-01');
    });

    it('lists activities without filters', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse([
        { id: 21, type: 'sms', subject: 'SMS Received', person_id: 2, done: true,
          add_time: '2026-04-01 10:00:00', duration: '00:00:00', note: null,
          due_date: null, due_time: null },
      ]));

      const result = await client.listActivities();

      expect(result).toHaveLength(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/activities');
      expect(url).not.toContain('type=');
    });

    it('returns empty array when no activities', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse(null));

      const result = await client.listActivities({ type: 'call' });
      expect(result).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws on API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      }));

      await expect(client.searchPersonByPhone('+15551234567')).rejects.toThrow('Pipedrive API error: 401');
    });
  });

  describe('static utilities', () => {
    it('getPrimaryPhone returns primary phone', () => {
      const person = {
        id: 1, name: 'Test',
        phone: [{ value: '+15551111111', primary: false }, { value: '+15552222222', primary: true }],
        email: [],
      };
      expect(PipedriveClient.getPrimaryPhone(person)).toBe('+15552222222');
    });

    it('getPrimaryPhone falls back to first phone', () => {
      const person = {
        id: 1, name: 'Test',
        phone: [{ value: '+15551111111', primary: false }],
        email: [],
      };
      expect(PipedriveClient.getPrimaryPhone(person)).toBe('+15551111111');
    });

    it('parseFullName splits correctly', () => {
      expect(PipedriveClient.parseFullName('John Doe')).toEqual({ firstName: 'John', lastName: 'Doe' });
      expect(PipedriveClient.parseFullName('John')).toEqual({ firstName: 'John', lastName: null });
      expect(PipedriveClient.parseFullName('John Michael Doe')).toEqual({ firstName: 'John', lastName: 'Michael Doe' });
    });
  });

  describe('PIPEDRIVE_CROSS_SYSTEM_FIELDS', () => {
    it('has expected field keys', () => {
      expect(PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID).toBeDefined();
      expect(PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID).toBeDefined();
    });
  });

  describe('rawGet', () => {
    it('builds URL with api_token + params and returns full response', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          success: true,
          data: [{ id: 1 }, { id: 2 }],
          additional_data: { pagination: { start: 0, limit: 100, more_items_in_collection: true, next_start: 100 } },
        }),
        text: () => Promise.resolve(''),
      }));

      const res = await client.rawGet<Array<{ id: number }>>('/deals', { start: 0, limit: 100, status: 'won' });
      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(2);
      expect(res.additional_data?.pagination?.more_items_in_collection).toBe(true);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('api.pipedrive.com/v1/deals');
      expect(url).toContain('api_token=test-api-key');
      expect(url).toContain('start=0');
      expect(url).toContain('limit=100');
      expect(url).toContain('status=won');
    });
  });
});

describe('shouldUpdateName', () => {
  describe('placeholder names — always allow update', () => {
    it('overwrites empty/undefined current name', () => {
      expect(shouldUpdateName('', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName(undefined, 'Sam Sabky')).toBe(true);
    });

    it('overwrites "Unknown Lead..." pattern', () => {
      expect(shouldUpdateName('Unknown Lead 5478', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName('Unknown Lead', 'Sam Sabky')).toBe(true);
    });

    it('overwrites bare phone numbers', () => {
      expect(shouldUpdateName('+19087459554', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName('(908) 745-9554', 'Sam Sabky')).toBe(true);
    });

    it('overwrites our own phone-suffix disambiguator', () => {
      expect(shouldUpdateName('Sam (·9554)', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName('Lead (·9554)', 'Sam Sabky')).toBe(true);
    });
  });

  describe('strict refinement — allow', () => {
    it('allows single-token to two-token with same first name', () => {
      expect(shouldUpdateName('Sam', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName('Tom', 'Tom Pfalzer')).toBe(true);
    });

    it('allows nickname pairs (Tom → Thomas)', () => {
      expect(shouldUpdateName('Tom', 'Thomas Pfalzer')).toBe(true);
      expect(shouldUpdateName('Mike', 'Michael Chen')).toBe(true);
      expect(shouldUpdateName('Bob', 'Robert Smith')).toBe(true);
      expect(shouldUpdateName('Liz', 'Elizabeth Johnson')).toBe(true);
    });

    it('allows formal → nickname pairs (Thomas → Tom)', () => {
      expect(shouldUpdateName('Thomas', 'Tom Pfalzer')).toBe(true);
    });

    it('allows adding middle name to existing two-token name', () => {
      expect(shouldUpdateName('Sam Sabky', 'Sam J Sabky')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(shouldUpdateName('sam', 'Sam Sabky')).toBe(true);
      expect(shouldUpdateName('SAM', 'sam sabky')).toBe(true);
    });
  });

  describe('block — different person', () => {
    it('blocks completely different name (third-party realtor case)', () => {
      expect(shouldUpdateName('Sam Sabky', 'Lisa Hartley')).toBe(false);
    });

    it('blocks different first name even with shared last name', () => {
      expect(shouldUpdateName('Sam Sabky', 'Tom Sabky')).toBe(false);
    });

    it('blocks unrelated single-token replacement', () => {
      expect(shouldUpdateName('Sam', 'Tom')).toBe(false);
    });
  });

  describe('block — degradation / no new info', () => {
    it('blocks update with same number of tokens (typo correction is too risky)', () => {
      expect(shouldUpdateName('Sam Sabky', 'Sam Saby')).toBe(false);
    });

    it('blocks shorter replacement', () => {
      expect(shouldUpdateName('Sam Sabky', 'Sam')).toBe(false);
    });

    it('blocks identical name', () => {
      expect(shouldUpdateName('Sam Sabky', 'Sam Sabky')).toBe(false);
    });

    it('blocks empty new name', () => {
      expect(shouldUpdateName('Sam Sabky', '')).toBe(false);
      expect(shouldUpdateName('Sam Sabky', undefined)).toBe(false);
    });
  });

  describe('block — refinement that contradicts existing tokens', () => {
    it('blocks when existing last name disappears in new name', () => {
      // "Sam Sabky" → "Sam Pfalzer Hartley": adds tokens but Sabky is gone
      expect(shouldUpdateName('Sam Sabky', 'Sam Pfalzer Hartley')).toBe(false);
    });
  });
});

describe('isNameRefinement', () => {
  it('handles whitespace and casing', () => {
    expect(isNameRefinement('  sam  ', 'SAM SABKY')).toBe(true);
  });

  it('does not allow the same first-name string when stripped', () => {
    expect(isNameRefinement('Sam', 'Sam')).toBe(false);
  });
});

// ── Deal CRUD ─────────────────────────────────────────────────────────

const FAKE_DEAL_SPINE: PipedriveDealSpineConfig = {
  pipelineId: 99,
  stageIds: {
    lead: 101,
    qualified_lead: 102,
    assessment_scheduled: 103,
    assessment_done: 104,
    quote_sent: 105,
    quote_accepted: 106,
    job_scheduled: 107,
    job_done: 108,
    paid: 109,
    lost: 110,
  },
  fieldHashes: {
    qbEstimateId: 'hash_qb_est',
    qbInvoiceId: 'hash_qb_inv',
    externalId: 'hash_ext_id',
    lostReason: 'hash_lost_reason',
  },
};

function makeDealClient() {
  return new PipedriveClient({
    apiKey: 'test-api-key',
    companyDomain: 'testcompany',
    dealSpine: FAKE_DEAL_SPINE,
  });
}

function makeRawDeal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    title: 'Smith — foundation repair',
    person_id: { value: 7, name: 'Smith' },
    org_id: null,
    stage_id: 101, // lead
    pipeline_id: 99,
    value: 5000,
    currency: 'USD',
    status: 'open',
    add_time: '2026-05-28 12:00:00',
    update_time: '2026-05-28 12:00:00',
    ...overrides,
  };
}

describe('PipedriveClient — Deal CRUD', () => {
  describe('config guard', () => {
    it('createDeal throws if dealSpine is not configured', async () => {
      const client = new PipedriveClient({ apiKey: 'k', companyDomain: 'd' });
      await expect(
        client.createDeal({ title: 'x', personId: 1 }),
      ).rejects.toThrow(/dealSpine is required/);
    });

    it('setDealStage throws if dealSpine is not configured', async () => {
      const client = new PipedriveClient({ apiKey: 'k', companyDomain: 'd' });
      await expect(client.setDealStage(1, 'lead')).rejects.toThrow(/dealSpine is required/);
    });
  });

  describe('createDeal', () => {
    it('posts with stage=lead by default and the configured pipeline_id', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(makeRawDeal()));

      const deal = await client.createDeal({ title: 'Smith — foundation repair', personId: 7 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/deals?');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.title).toBe('Smith — foundation repair');
      expect(body.person_id).toBe(7);
      expect(body.pipeline_id).toBe(99);
      expect(body.stage_id).toBe(101); // lead

      expect(deal.id).toBe(42);
      expect(deal.stage).toBe('lead');
      expect(deal.personId).toBe(7);
    });

    it('passes optional custom fields through their hashes', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(makeRawDeal()));

      await client.createDeal({
        title: 'x',
        personId: 7,
        stage: 'quote_sent',
        value: 4200,
        qbEstimateId: 'qb-est-1234',
        externalId: 'qb-est-1234',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.stage_id).toBe(105); // quote_sent
      expect(body.value).toBe(4200);
      expect(body.hash_qb_est).toBe('qb-est-1234');
      expect(body.hash_ext_id).toBe('qb-est-1234');
      expect(body.hash_qb_inv).toBeUndefined();
    });
  });

  describe('getDeal', () => {
    it('parses a deal from raw PD shape including custom fields', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(
        mockResponse(
          makeRawDeal({
            stage_id: 105,
            hash_qb_est: 'qb-est-1234',
            hash_qb_inv: 'qb-inv-5678',
            hash_ext_id: 'qb-est-1234',
            hash_lost_reason: '',
          }),
        ),
      );

      const deal = await client.getDeal(42);

      expect(deal).not.toBeNull();
      expect(deal!.id).toBe(42);
      expect(deal!.stage).toBe('quote_sent');
      expect(deal!.qbEstimateId).toBe('qb-est-1234');
      expect(deal!.qbInvoiceId).toBe('qb-inv-5678');
      expect(deal!.externalId).toBe('qb-est-1234');
      expect(deal!.lostReason).toBeNull();
    });

    it('returns null on API error', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse({ error: 'not found' }, 404));

      const deal = await client.getDeal(999);
      expect(deal).toBeNull();
    });

    it('returns stage=null when stageId is not in the configured map', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(makeRawDeal({ stage_id: 9999 })));

      const deal = await client.getDeal(42);
      expect(deal!.stage).toBeNull();
      expect(deal!.stageId).toBe(9999);
    });
  });

  describe('updateDeal', () => {
    it('only sends the fields that are passed', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(makeRawDeal()));

      await client.updateDeal(42, { qbInvoiceId: 'qb-inv-5678' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/deals/42');
      expect(init.method).toBe('PUT');
      const body = JSON.parse(init.body as string);
      expect(body.hash_qb_inv).toBe('qb-inv-5678');
      expect(body.hash_qb_est).toBeUndefined();
      expect(body.title).toBeUndefined();
    });
  });

  describe('getDealsByPerson', () => {
    it('returns an empty array when person has no deals', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(null));

      const deals = await client.getDealsByPerson(7);
      expect(deals).toEqual([]);
    });

    it('returns parsed deals when the person has some', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(
        mockResponse([makeRawDeal(), makeRawDeal({ id: 43, stage_id: 109 })]),
      );

      const deals = await client.getDealsByPerson(7);
      expect(deals).toHaveLength(2);
      expect(deals[0].stage).toBe('lead');
      expect(deals[1].stage).toBe('paid');
    });
  });

  describe('setDealStage', () => {
    it('PUTs just stage_id, mapped from the stage name', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse(makeRawDeal({ stage_id: 107 })));

      const deal = await client.setDealStage(42, 'job_scheduled');

      const init = mockFetch.mock.calls[0][1];
      expect(init.method).toBe('PUT');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ stage_id: 107 });
      expect(deal.stage).toBe('job_scheduled');
    });
  });

  describe('markDealLost', () => {
    it('sets status=lost, stage=lost, and the lost_reason custom field', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(
        mockResponse(
          makeRawDeal({
            stage_id: 110,
            status: 'lost',
            hash_lost_reason: 'out_of_scope',
          }),
        ),
      );

      const deal = await client.markDealLost(42, 'out_of_scope');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.status).toBe('lost');
      expect(body.stage_id).toBe(110); // lost
      expect(body.hash_lost_reason).toBe('out_of_scope');

      expect(deal.status).toBe('lost');
      expect(deal.stage).toBe('lost');
      expect(deal.lostReason).toBe('out_of_scope');
    });
  });

  describe('findDealByExternalId', () => {
    it('search-then-fetch: returns the full deal when search hits', async () => {
      const client = makeDealClient();
      // First call: /deals/search
      mockFetch.mockReturnValueOnce(mockResponse({ items: [{ item: { id: 42 } }] }));
      // Second call: /deals/42
      mockFetch.mockReturnValueOnce(
        mockResponse(makeRawDeal({ hash_ext_id: 'qb-est-1234' })),
      );

      const deal = await client.findDealByExternalId('qb-est-1234');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain('/deals/search');
      expect(mockFetch.mock.calls[0][0]).toContain('term=qb-est-1234');
      expect(mockFetch.mock.calls[1][0]).toContain('/deals/42');
      expect(deal!.id).toBe(42);
      expect(deal!.externalId).toBe('qb-est-1234');
    });

    it('returns null when search finds nothing', async () => {
      const client = makeDealClient();
      mockFetch.mockReturnValueOnce(mockResponse({ items: [] }));

      const deal = await client.findDealByExternalId('qb-est-nonexistent');
      expect(deal).toBeNull();
      expect(mockFetch).toHaveBeenCalledOnce(); // no second fetch
    });
  });

  describe('rate limiting (429 handling)', () => {
    function mock429(retryAfter?: string) {
      const headers = new Map<string, string>();
      if (retryAfter !== undefined) headers.set('retry-after', retryAfter);
      return Promise.resolve({
        ok: false,
        status: 429,
        headers,
        text: () => Promise.resolve('request over limit'),
      });
    }

    it('retries after a 429 and succeeds', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        mockFetch
          .mockReturnValueOnce(mock429())
          .mockReturnValueOnce(mockResponse({ items: [] }));

        const promise = client.searchPersonByPhone('+15551234567');
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('honors the Retry-After header for backoff timing', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        mockFetch
          .mockReturnValueOnce(mock429('1')) // 1 second
          .mockReturnValueOnce(mockResponse({ items: [] }));

        const promise = client.searchPersonByPhone('+15551234567');
        await vi.runAllTimersAsync();
        await promise;

        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces the error after exhausting retries', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        // Attempts 0..3 all 429 → 4 fetches, then throw.
        for (let i = 0; i < 4; i++) mockFetch.mockReturnValueOnce(mock429());

        const promise = client.searchPersonByPhone('+15551234567');
        const expectation = expect(promise).rejects.toThrow(
          'Pipedrive API error: 429',
        );
        await vi.runAllTimersAsync();
        await expectation;

        expect(mockFetch).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
