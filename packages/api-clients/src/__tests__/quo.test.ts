import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuoClient } from '../quo.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient() {
  return new QuoClient({
    apiKey: 'test-api-key',
    phoneNumber: '+15550001111',
    webhookSecret: 'test-secret',
  });
}

function mockResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('QuoClient', () => {
  describe('searchContactByPhone', () => {
    it('finds a contact by phone', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        data: [{
          id: 'quo-1',
          defaultFields: {
            firstName: 'John', lastName: 'Doe', company: null,
            emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
          },
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        }],
      }));

      const result = await client.searchContactByPhone('+15551234567');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('quo-1');
    });

    it('returns null when no match', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ data: [] }));

      const result = await client.searchContactByPhone('+15559999999');
      expect(result).toBeNull();
    });

    it('passes auth header', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ data: [] }));

      await client.searchContactByPhone('+15551234567');
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('test-api-key');
    });
  });

  describe('createContact', () => {
    it('creates a contact', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        data: {
          id: 'quo-2',
          defaultFields: {
            firstName: 'Jane', lastName: 'Doe', company: null,
            emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
          },
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      }));

      const result = await client.createContact({
        defaultFields: {
          firstName: 'Jane',
          lastName: 'Doe',
          phoneNumbers: [{ value: '+15551234567', name: 'Mobile' }],
        },
      });

      expect(result.id).toBe('quo-2');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    });

    it('forwards externalId and source so future lookups can use the fast index', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        data: {
          id: 'quo-3',
          defaultFields: {
            firstName: 'Jane', lastName: null, company: null,
            emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
          },
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      }));

      await client.createContact({
        defaultFields: {
          firstName: 'Jane',
          phoneNumbers: [{ value: '+15551234567', name: 'mobile' }],
        },
        externalId: '+15551234567',
        source: 'aac-middleware',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.externalId).toBe('+15551234567');
      expect(body.source).toBe('aac-middleware');
    });
  });

  describe('findContactByExternalId', () => {
    it('queries with externalIds[]= and returns the first match', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        data: [{
          id: 'quo-9',
          defaultFields: {
            firstName: 'Nick', lastName: 'Puccio', company: null,
            emails: [], phoneNumbers: [{ value: '+15085231758' }], role: null,
          },
          createdAt: '2026-05-20', updatedAt: '2026-05-20',
        }],
      }));

      const result = await client.findContactByExternalId('+15085231758');

      expect(result?.id).toBe('quo-9');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('externalIds%5B%5D=%2B15085231758');
    });

    it('returns null when nothing matches', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ data: [] }));

      const result = await client.findContactByExternalId('+15559999999');
      expect(result).toBeNull();
    });
  });

  describe('findContactByPhone', () => {
    it('returns immediately on externalId hit without paginating', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        data: [{
          id: 'quo-fast',
          defaultFields: {
            firstName: 'Fast', lastName: 'Path', company: null,
            emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
          },
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        }],
      }));

      const result = await client.findContactByPhone('+15551234567');
      expect(result?.id).toBe('quo-fast');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to linear scan when externalId misses', async () => {
      const client = makeClient();
      // First call: externalId lookup returns no match
      mockFetch.mockReturnValueOnce(mockResponse({ data: [] }));
      // Second call: full-scan first page returns the contact
      mockFetch.mockReturnValueOnce(mockResponse({
        data: [{
          id: 'quo-legacy',
          defaultFields: {
            firstName: 'Legacy', lastName: 'Contact', company: null,
            emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
          },
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        }],
      }));

      const result = await client.findContactByPhone('+15551234567');
      expect(result?.id).toBe('quo-legacy');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendMessage', () => {
    it('sends SMS with default from number', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ data: { id: 'msg-1' } }));

      const result = await client.sendMessage('+15559999999', 'Hello!');
      expect(result.id).toBe('msg-1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe('+15550001111');
      expect(body.to).toEqual(['+15559999999']);
      expect(body.content).toBe('Hello!');
    });

    it('allows custom from number', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ data: { id: 'msg-2' } }));

      await client.sendMessage('+15559999999', 'Hello!', '+15558888888');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe('+15558888888');
    });
  });

  describe('deleteContact', () => {
    it('sends DELETE request', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) }));

      await client.deleteContact('quo-1');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws on API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false, status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }));

      await expect(client.createContact({
        defaultFields: { phoneNumbers: [{ value: '+15551234567', name: 'Mobile' }] },
      })).rejects.toThrow('Quo API error: 500');
    });
  });

  describe('static utilities', () => {
    it('parseFullName splits correctly', () => {
      expect(QuoClient.parseFullName('John Doe')).toEqual({ firstName: 'John', lastName: 'Doe' });
      expect(QuoClient.parseFullName('John')).toEqual({ firstName: 'John', lastName: null });
    });

    it('getFullName builds name from contact', () => {
      const contact = {
        id: 'c1',
        defaultFields: {
          firstName: 'John', lastName: 'Doe', company: null,
          emails: [], phoneNumbers: [], role: null,
        },
        createdAt: '', updatedAt: '',
      };
      expect(QuoClient.getFullName(contact)).toBe('John Doe');
    });

    it('getPrimaryPhone returns first phone', () => {
      const contact = {
        id: 'c1',
        defaultFields: {
          firstName: null, lastName: null, company: null,
          emails: [], phoneNumbers: [{ value: '+15551234567' }], role: null,
        },
        createdAt: '', updatedAt: '',
      };
      expect(QuoClient.getPrimaryPhone(contact)).toBe('+15551234567');
    });
  });
});
