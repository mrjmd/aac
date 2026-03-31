import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipedriveClient, PIPEDRIVE_CROSS_SYSTEM_FIELDS } from '../pipedrive.js';

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
    it('logs an activity with correct type', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ id: 10, type: 'call', subject: 'Test', person_id: 1, done: true }));

      const result = await client.logActivity(1, 'call', { subject: 'Inbound call', duration: 120 });
      expect(result.id).toBe(10);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('call');
      expect(body.person_id).toBe(1);
      expect(body.duration).toBe(120);
      expect(body.done).toBe(true);
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
});
