import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuickBooksClient } from '../quickbooks.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient(tokenOverrides?: Partial<ReturnType<typeof makeTokens>>) {
  const tokens = { ...makeTokens(), ...tokenOverrides };
  return new QuickBooksClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    realmId: 'test-realm',
    redirectUri: 'http://localhost/callback',
    getTokens: vi.fn().mockResolvedValue(tokens),
    saveTokens: vi.fn().mockResolvedValue(undefined),
  });
}

function makeTokens() {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    realmId: 'test-realm',
  };
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

describe('QuickBooksClient', () => {
  describe('searchCustomerByEmail', () => {
    it('finds a customer by email', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Customer: [{ Id: 'qb-1', DisplayName: 'John Doe' }],
        },
      }));

      const result = await client.searchCustomerByEmail('john@example.com');
      expect(result).not.toBeNull();
      expect(result!.Id).toBe('qb-1');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('quickbooks.api.intuit.com');
      expect(url).toContain('test-realm');
    });

    it('returns null when no match', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      const result = await client.searchCustomerByEmail('nobody@example.com');
      expect(result).toBeNull();
    });
  });

  describe('createCustomer', () => {
    it('creates a customer', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Customer: { Id: 'qb-2', DisplayName: 'Jane Doe' },
      }));

      const result = await client.createCustomer({
        displayName: 'Jane Doe',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phone: '+15551234567',
      });

      expect(result.Id).toBe('qb-2');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.DisplayName).toBe('Jane Doe');
      expect(body.PrimaryEmailAddr.Address).toBe('jane@example.com');
      expect(body.PrimaryPhone.FreeFormNumber).toBe('+15551234567');
    });
  });

  describe('token refresh', () => {
    it('refreshes token when expired', async () => {
      const expiredTokens = {
        accessToken: 'expired',
        refreshToken: 'valid-refresh',
        expiresAt: Date.now() - 1000, // expired
        realmId: 'test-realm',
      };

      const saveTokens = vi.fn().mockResolvedValue(undefined);
      const client = new QuickBooksClient({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        realmId: 'test-realm',
        redirectUri: 'http://localhost/callback',
        getTokens: vi.fn().mockResolvedValue(expiredTokens),
        saveTokens,
      });

      // First call: token refresh. Second call: actual API call.
      mockFetch.mockReturnValueOnce(mockResponse({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }));
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');

      // Token refresh was called
      expect(mockFetch.mock.calls[0][0]).toContain('oauth.platform.intuit.com');
      expect(saveTokens).toHaveBeenCalledOnce();
      expect(saveTokens.mock.calls[0][0].accessToken).toBe('new-access-token');
    });
  });

  describe('isConnected', () => {
    it('returns true when tokens are valid', async () => {
      const client = makeClient();
      const result = await client.isConnected();
      expect(result).toBe(true);
    });

    it('returns false when no tokens', async () => {
      const client = new QuickBooksClient({
        clientId: 'test',
        clientSecret: 'test',
        realmId: 'test',
        redirectUri: 'http://localhost/callback',
        getTokens: vi.fn().mockResolvedValue(null),
        saveTokens: vi.fn(),
      });

      const result = await client.isConnected();
      expect(result).toBe(false);
    });
  });

  describe('auth header', () => {
    it('passes Bearer token', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-access-token');
    });
  });
});
