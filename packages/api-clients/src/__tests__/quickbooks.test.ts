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

  describe('searchCustomerByName', () => {
    it('queries active customers only by default', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByName('John Doe');

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("DisplayName = 'John Doe'");
      expect(url).not.toContain('Active IN');
    });

    it('includes inactive customers when includeInactive is set', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Customer: [{ Id: 'qb-9', DisplayName: 'John Doe', Active: false }],
        },
      }));

      const result = await client.searchCustomerByName('John Doe', { includeInactive: true });

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain('Active IN (true, false)');
      expect(result!.Id).toBe('qb-9');
      expect(result!.Active).toBe(false);
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

  describe('token refresh malformed payload', () => {
    it('throws instead of storing NaN expiry when the oauth response is malformed', async () => {
      const saveTokens = vi.fn().mockResolvedValue(undefined);
      const client = new QuickBooksClient({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        realmId: 'test-realm',
        redirectUri: 'http://localhost/callback',
        getTokens: vi.fn().mockResolvedValue({
          accessToken: 'expired',
          refreshToken: 'valid-refresh',
          expiresAt: Date.now() - 1000,
          realmId: 'test-realm',
        }),
        saveTokens,
      });
      mockFetch.mockReturnValueOnce(mockResponse({ error: 'proxy mangled this' }));

      await expect(client.searchCustomerByEmail('x@example.com')).rejects.toThrow(
        /malformed payload/
      );
      expect(saveTokens).not.toHaveBeenCalled();
    });
  });

  describe('refresh single-flight lock (P4-1)', () => {
    function makeLockedClient(opts: {
      tokens: ReturnType<typeof makeTokens> | Array<ReturnType<typeof makeTokens>>;
      acquire: boolean;
      waitMs?: number;
      maxWaitAttempts?: number;
    }) {
      const getTokens = vi.fn();
      if (Array.isArray(opts.tokens)) {
        for (const t of opts.tokens) getTokens.mockResolvedValueOnce(t);
        getTokens.mockResolvedValue(opts.tokens[opts.tokens.length - 1]);
      } else {
        getTokens.mockResolvedValue(opts.tokens);
      }
      const acquire = vi.fn().mockResolvedValue(opts.acquire);
      const release = vi.fn().mockResolvedValue(undefined);
      const saveTokens = vi.fn().mockResolvedValue(undefined);
      const client = new QuickBooksClient({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        realmId: 'test-realm',
        redirectUri: 'http://localhost/callback',
        getTokens,
        saveTokens,
        refreshLock: {
          acquire,
          release,
          waitMs: opts.waitMs ?? 1,
          maxWaitAttempts: opts.maxWaitAttempts ?? 3,
        },
      });
      return { client, getTokens, saveTokens, acquire, release };
    }

    const expired = () => ({
      accessToken: 'expired',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1000,
      realmId: 'test-realm',
    });

    it('refreshes under the lock and releases it', async () => {
      const { client, acquire, release, saveTokens } = makeLockedClient({
        tokens: expired(),
        acquire: true,
      });
      mockFetch.mockReturnValueOnce(mockResponse({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }));
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');

      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(saveTokens).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toContain('oauth.platform.intuit.com');
    });

    it('skips the refresh when another process refreshed between read and acquire', async () => {
      const fresh = { ...makeTokens(), accessToken: 'already-refreshed' };
      const { client, release, saveTokens } = makeLockedClient({
        tokens: [expired(), fresh],
        acquire: true,
      });
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');

      // Only the API call — no oauth call
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('quickbooks.api.intuit.com');
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer already-refreshed');
      expect(saveTokens).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it('uses the still-valid buffer-window token when the lock is held elsewhere', async () => {
      const inBuffer = {
        accessToken: 'buffer-token',
        refreshToken: 'r',
        expiresAt: Date.now() + 60_000, // inside the 5-min buffer, not yet expired
        realmId: 'test-realm',
      };
      const { client, release, saveTokens } = makeLockedClient({
        tokens: inBuffer,
        acquire: false,
      });
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer buffer-token');
      expect(saveTokens).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('waits for the other refresher when hard-expired and lock is held', async () => {
      const fresh = { ...makeTokens(), accessToken: 'refreshed-elsewhere' };
      const { client } = makeLockedClient({
        tokens: [expired(), expired(), fresh],
        acquire: false,
      });
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      await client.searchCustomerByEmail('test@example.com');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer refreshed-elsewhere');
    });

    it('throws when hard-expired, lock held, and no fresh token appears', async () => {
      const { client, saveTokens } = makeLockedClient({
        tokens: expired(),
        acquire: false,
        maxWaitAttempts: 2,
      });

      await expect(client.searchCustomerByEmail('test@example.com')).rejects.toThrow(
        /held by another process/
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(saveTokens).not.toHaveBeenCalled();
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

  describe('query', () => {
    it('URL-encodes the SQL and pins minor version', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: { Item: [{ Id: '1', Name: 'Crack Repair' }] },
      }));

      const result = await client.query<{ QueryResponse: { Item: Array<{ Id: string }> } }>(
        "SELECT * FROM Item WHERE Type = 'Service'"
      );

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/query?query=');
      expect(url).toContain('SELECT%20*%20FROM%20Item');
      expect(url).toContain('Type%20%3D%20');
      expect(url).toContain('minorversion=70');
      expect(result.QueryResponse.Item[0].Id).toBe('1');
    });
  });

  describe('getEstimatesByCustomer', () => {
    it('queries by customer and filters status client-side (TxnStatus not queryable in QB SQL)', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Estimate: [
            { Id: 'est-1', SyncToken: '0', TxnStatus: 'Accepted', CustomerRef: { value: 'c-1' }, Line: [] },
            { Id: 'est-2', SyncToken: '0', TxnStatus: 'Pending', CustomerRef: { value: 'c-1' }, Line: [] },
            { Id: 'est-3', SyncToken: '0', TxnStatus: 'Rejected', CustomerRef: { value: 'c-1' }, Line: [] },
          ],
        },
      }));

      const result = await client.getEstimatesByCustomer('c-1', 'Accepted');

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).toContain('FROM Estimate');
      expect(decoded).toContain("CustomerRef = 'c-1'");
      expect(decoded).toContain('ORDER BY MetaData.CreateTime DESC');
      // TxnStatus filter is NOT in the SQL — QB rejects it as not queryable
      expect(decoded).not.toContain('TxnStatus');
      // Client-side filter narrowed the result set
      expect(result).toHaveLength(1);
      expect(result[0].Id).toBe('est-1');
    });

    it('returns empty array when no estimates found', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      const result = await client.getEstimatesByCustomer('c-9');
      expect(result).toEqual([]);
    });

    it('returns all estimates when status filter omitted', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Estimate: [
            { Id: 'est-1', SyncToken: '0', TxnStatus: 'Accepted', CustomerRef: { value: 'c-1' }, Line: [] },
            { Id: 'est-2', SyncToken: '0', TxnStatus: 'Pending', CustomerRef: { value: 'c-1' }, Line: [] },
          ],
        },
      }));

      const result = await client.getEstimatesByCustomer('c-1');
      expect(result).toHaveLength(2);
    });
  });

  describe('getInvoicesByCustomer', () => {
    it('filters by customer and optional sinceISODate', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Invoice: [
            { Id: 'inv-1', SyncToken: '0', CustomerRef: { value: 'c-1' }, Line: [], Balance: 100 },
          ],
        },
      }));

      const result = await client.getInvoicesByCustomer('c-1', '2026-05-16');

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).toContain("FROM Invoice");
      expect(decoded).toContain("CustomerRef = 'c-1'");
      expect(decoded).toContain("TxnDate >= '2026-05-16'");
      expect(result[0].Id).toBe('inv-1');
    });
  });

  describe('listRecentEstimates', () => {
    it('queries all estimates with optional sinceISODate, no TxnStatus filter in SQL', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Estimate: [
            { Id: 'est-1', SyncToken: '0', TxnStatus: 'Accepted', CustomerRef: { value: 'c-1' }, Line: [] },
            { Id: 'est-2', SyncToken: '0', TxnStatus: 'Pending', CustomerRef: { value: 'c-2' }, Line: [] },
          ],
        },
      }));

      const result = await client.listRecentEstimates('2026-04-28');

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).toContain('FROM Estimate');
      expect(decoded).toContain("TxnDate >= '2026-04-28'");
      expect(decoded).not.toContain('TxnStatus');
      expect(decoded).toContain('MAXRESULTS 200');
      expect(result).toHaveLength(2);
    });

    it('omits the date predicate when sinceISODate is undefined', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: { Estimate: [] } }));

      await client.listRecentEstimates();

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).not.toContain('WHERE');
      expect(decoded).not.toContain('TxnDate');
    });

    it('returns empty array when no estimates exist', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      const result = await client.listRecentEstimates();
      expect(result).toEqual([]);
    });
  });

  describe('listRecentInvoices', () => {
    it('queries all invoices with optional sinceISODate', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Invoice: [
            { Id: 'inv-1', SyncToken: '0', CustomerRef: { value: 'c-1' }, Line: [], Balance: 0 },
            { Id: 'inv-2', SyncToken: '0', CustomerRef: { value: 'c-2' }, Line: [], Balance: 500 },
          ],
        },
      }));

      const result = await client.listRecentInvoices('2026-03-28');

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).toContain('FROM Invoice');
      expect(decoded).toContain("TxnDate >= '2026-03-28'");
      expect(decoded).toContain('MAXRESULTS 200');
      expect(result).toHaveLength(2);
    });

    it('omits the date predicate when sinceISODate is undefined', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: { Invoice: [] } }));

      await client.listRecentInvoices();

      const url = mockFetch.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.split('query=')[1].split('&')[0]);
      expect(decoded).not.toContain('WHERE');
    });

    it('returns empty array when no invoices exist', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));

      const result = await client.listRecentInvoices();
      expect(result).toEqual([]);
    });
  });

  describe('createInvoiceFromEstimate', () => {
    it('fetches the estimate, posts an invoice with LinkedTxn, drops subtotal lines', async () => {
      const client = makeClient();
      // 1) GET /estimate/<id>
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: {
          Id: 'est-7',
          SyncToken: '0',
          CustomerRef: { value: 'c-1', name: 'Smith' },
          Line: [
            { Amount: 1500, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, UnitPrice: 1500 } },
            { Amount: 1500, DetailType: 'SubTotalLineDetail' },
          ],
          BillEmail: { Address: 'smith@example.com' },
        },
      }));
      // 2) POST /invoice
      mockFetch.mockReturnValueOnce(mockResponse({
        Invoice: { Id: 'inv-7', SyncToken: '0', CustomerRef: { value: 'c-1' }, Line: [], TotalAmt: 1500, Balance: 1500 },
      }));

      const result = await client.createInvoiceFromEstimate('est-7');

      expect(result.Id).toBe('inv-7');

      const getUrl = mockFetch.mock.calls[0][0] as string;
      expect(getUrl).toContain('/estimate/est-7');

      const postCall = mockFetch.mock.calls[1];
      const postUrl = postCall[0] as string;
      const postBody = JSON.parse((postCall[1] as { body: string }).body);
      expect(postUrl).toContain('/invoice');
      expect(postBody.CustomerRef.value).toBe('c-1');
      expect(postBody.LinkedTxn).toEqual([{ TxnId: 'est-7', TxnType: 'Estimate' }]);
      // SubTotal line was dropped
      expect(postBody.Line).toHaveLength(1);
      expect(postBody.Line[0].DetailType).toBe('SalesItemLineDetail');
      expect(postBody.BillEmail.Address).toBe('smith@example.com');
    });

    it('throws when the estimate is not found', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({}));

      await expect(client.createInvoiceFromEstimate('missing')).rejects.toThrow(
        /estimate missing not found/
      );
    });
  });

  describe('updateEstimateStatus', () => {
    it('fetches the estimate then sparse-POSTs the new TxnStatus with its SyncToken', async () => {
      const client = makeClient();
      // 1) GET /estimate/<id>
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: 'est-9', SyncToken: '3', TxnStatus: 'Pending', CustomerRef: { value: 'c-1' }, Line: [] },
      }));
      // 2) POST /estimate
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: 'est-9', SyncToken: '4', TxnStatus: 'Closed', CustomerRef: { value: 'c-1' }, Line: [] },
      }));

      const result = await client.updateEstimateStatus('est-9', 'Closed');

      expect(result.TxnStatus).toBe('Closed');

      const getUrl = mockFetch.mock.calls[0][0] as string;
      expect(getUrl).toContain('/estimate/est-9');

      const postCall = mockFetch.mock.calls[1];
      const postUrl = postCall[0] as string;
      const postBody = JSON.parse((postCall[1] as { body: string }).body);
      expect(postUrl).toContain('/estimate');
      expect(postBody).toEqual({ Id: 'est-9', SyncToken: '3', sparse: true, TxnStatus: 'Closed' });
    });

    it('throws when the estimate is not found', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({}));

      await expect(client.updateEstimateStatus('missing', 'Closed')).rejects.toThrow(
        /estimate missing not found/
      );
    });
  });

  describe('sendInvoice', () => {
    it('POSTs to /invoice/{id}/send and passes sendTo when email given', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Invoice: { Id: 'inv-7', SyncToken: '1', CustomerRef: { value: 'c-1' }, Line: [], EmailStatus: 'EmailSent' },
      }));

      const result = await client.sendInvoice('inv-7', 'override@example.com');

      const url = mockFetch.mock.calls[0][0] as string;
      const init = mockFetch.mock.calls[0][1] as { method: string; headers?: Record<string, string> };
      expect(url).toContain('/invoice/inv-7/send');
      expect(url).toContain('sendTo=override%40example.com');
      expect(init.method).toBe('POST');
      // QBO send endpoint NPEs with application/json + empty body; must use octet-stream.
      expect(init.headers?.['Content-Type']).toBe('application/octet-stream');
      expect(result.EmailStatus).toBe('EmailSent');
    });

    it('omits sendTo when no email provided (uses QB default billing email)', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Invoice: { Id: 'inv-7', SyncToken: '1', CustomerRef: { value: 'c-1' }, Line: [], EmailStatus: 'EmailSent' },
      }));

      await client.sendInvoice('inv-7');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/invoice/inv-7/send');
      expect(url).not.toContain('sendTo=');
    });
  });

  describe('getInvoice', () => {
    it('GETs /invoice/{id} and returns the invoice', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Invoice: { Id: 'inv-7', SyncToken: '1', CustomerRef: { value: 'c-1' }, Line: [], Balance: 0 },
      }));

      const inv = await client.getInvoice('inv-7');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/invoice/inv-7');
      expect(inv?.Id).toBe('inv-7');
      expect(inv?.Balance).toBe(0);
    });

    it('returns null on error (404, network)', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ Fault: { type: 'not_found' } }, 404));
      const inv = await client.getInvoice('missing');
      expect(inv).toBeNull();
    });
  });

  describe('listPaymentMethods', () => {
    it('queries the PaymentMethod entity', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          PaymentMethod: [
            { Id: '1', Name: 'Cash', Type: 'NON_CREDIT_CARD', Active: true },
            { Id: '2', Name: 'Check', Type: 'NON_CREDIT_CARD', Active: true },
            { Id: '3', Name: 'Credit Card', Type: 'CREDIT_CARD', Active: true },
          ],
        },
      }));

      const methods = await client.listPaymentMethods();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(decodeURIComponent(url)).toContain('SELECT * FROM PaymentMethod');
      expect(methods.map((m) => m.Name)).toEqual(['Cash', 'Check', 'Credit Card']);
    });
  });

  describe('createPaymentForInvoice', () => {
    it('POSTs /payment with the right body shape', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Payment: { Id: 'pay-1', SyncToken: '0', TotalAmt: 1500, CustomerRef: { value: 'c-1' } },
      }));

      const payment = await client.createPaymentForInvoice({
        invoiceId: 'inv-7',
        customerId: 'c-1',
        amount: 1500,
        paymentMethodId: '2',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/payment');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        TotalAmt: 1500,
        CustomerRef: { value: 'c-1' },
        PaymentMethodRef: { value: '2' },
        Line: [
          {
            Amount: 1500,
            LinkedTxn: [{ TxnId: 'inv-7', TxnType: 'Invoice' }],
          },
        ],
      });
      expect(body.TxnDate).toBeUndefined();
      expect(payment.Id).toBe('pay-1');
    });

    it('includes TxnDate when provided', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Payment: { Id: 'pay-2', SyncToken: '0', TotalAmt: 800, CustomerRef: { value: 'c-1' } },
      }));

      await client.createPaymentForInvoice({
        invoiceId: 'inv-9',
        customerId: 'c-1',
        amount: 800,
        paymentMethodId: '1',
        txnDate: '2026-05-26',
      });

      const init = mockFetch.mock.calls[0][1] as { body: string };
      const body = JSON.parse(init.body);
      expect(body.TxnDate).toBe('2026-05-26');
    });

    it('throws if QuickBooks omits the Payment field', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ Fault: { type: 'validation' } }));
      await expect(
        client.createPaymentForInvoice({
          invoiceId: 'inv-7',
          customerId: 'c-1',
          amount: 100,
          paymentMethodId: '1',
        })
      ).rejects.toThrow(/did not return payment/);
    });
  });

  describe('listAccounts', () => {
    it('queries for accounts of a given type, active only by default', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Account: [
            { Id: '17', Name: 'Business Checking', AccountType: 'Bank', Active: true, CurrentBalance: 127161 },
          ],
        },
      }));

      const accts = await client.listAccounts({ type: 'Bank' });

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("AccountType = 'Bank'");
      expect(url).toContain('Active = true');
      expect(accts[0].Name).toBe('Business Checking');
    });

    it('omits the Active filter when activeOnly=false', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: { Account: [] } }));
      await client.listAccounts({ type: 'Bank', activeOnly: false });
      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).not.toContain('Active = true');
    });
  });

  describe('createDeposit', () => {
    it('POSTs /deposit with one DepositLine per payment, each linked via LinkedTxn', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Deposit: {
          Id: 'dep-1', SyncToken: '0', TotalAmt: 2050,
          DepositToAccountRef: { value: '17' },
          Line: [],
        },
      }));

      const dep = await client.createDeposit({
        depositToAccountId: '17',
        payments: [
          { paymentId: '2353', amount: 1175 },
          { paymentId: '2350', amount: 875 },
        ],
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/deposit');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.DepositToAccountRef).toEqual({ value: '17' });
      expect(body.Line).toHaveLength(2);
      expect(body.Line[0]).toMatchObject({
        Amount: 1175,
        DetailType: 'DepositLineDetail',
        LinkedTxn: [{ TxnId: '2353', TxnType: 'Payment' }],
      });
      expect(body.Line[1]).toMatchObject({
        Amount: 875,
        LinkedTxn: [{ TxnId: '2350', TxnType: 'Payment' }],
      });
      expect(dep.Id).toBe('dep-1');
    });

    it('throws when called with no payments', async () => {
      const client = makeClient();
      await expect(
        client.createDeposit({ depositToAccountId: '17', payments: [] })
      ).rejects.toThrow(/at least one payment/);
    });

    it('includes TxnDate when provided', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Deposit: { Id: 'dep-2', SyncToken: '0', TotalAmt: 100, DepositToAccountRef: { value: '17' }, Line: [] },
      }));
      await client.createDeposit({
        depositToAccountId: '17',
        payments: [{ paymentId: 'p1', amount: 100 }],
        txnDate: '2026-05-27',
      });
      const init = mockFetch.mock.calls[0][1] as { body: string };
      expect(JSON.parse(init.body).TxnDate).toBe('2026-05-27');
    });
  });

  describe('listRecentDeposits', () => {
    it('queries Deposit table ordered by TxnDate', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Deposit: [
            { Id: 'd-1', SyncToken: '0', TotalAmt: 100, DepositToAccountRef: { value: '17' }, Line: [] },
          ],
        },
      }));
      const deps = await client.listRecentDeposits(50);
      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain('SELECT * FROM Deposit');
      expect(url).toContain('MAXRESULTS 50');
      expect(deps).toHaveLength(1);
    });
  });

  describe('getPayment', () => {
    it('GETs /payment/{id} and returns the payment', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Payment: {
          Id: 'pay-7',
          SyncToken: '0',
          TotalAmt: 500,
          CustomerRef: { value: 'c-1' },
          PaymentMethodRef: { value: '3', name: 'Credit Card' },
        },
      }));

      const p = await client.getPayment('pay-7');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/payment/pay-7');
      expect(p?.Id).toBe('pay-7');
      expect(p?.PaymentMethodRef?.value).toBe('3');
    });

    it('returns null on error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ Fault: { type: 'not_found' } }, 404));
      const p = await client.getPayment('missing');
      expect(p).toBeNull();
    });
  });

  describe('report', () => {
    it('builds report URL with params and minor version', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Header: { ReportName: 'ProfitAndLoss' },
        Rows: { Row: [] },
      }));

      await client.report('ProfitAndLoss', {
        start_date: '2024-09-01',
        end_date: '2024-09-30',
        summarize_column_by: 'Month',
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/reports/ProfitAndLoss?');
      expect(url).toContain('start_date=2024-09-01');
      expect(url).toContain('end_date=2024-09-30');
      expect(url).toContain('summarize_column_by=Month');
      expect(url).toContain('minorversion=70');
    });

    it('works with no params', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ Header: {}, Rows: {} }));

      await client.report('BalanceSheet');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/reports/BalanceSheet?');
      expect(url).toContain('minorversion=70');
    });
  });

  describe('createEstimate', () => {
    it('creates a Pending estimate with mixed line types and a private note', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: {
          Id: '901',
          SyncToken: '0',
          DocNumber: '1532',
          TxnStatus: 'Pending',
          CustomerRef: { value: '42' },
          Line: [],
          TotalAmt: 3450,
        },
      }));

      const estimate = await client.createEstimate({
        customerId: '42',
        lines: [
          {
            DetailType: 'DescriptionOnly',
            Description: 'BOT DRAFT — REVIEW BEFORE SENDING',
            DescriptionLineDetail: {},
          },
          {
            DetailType: 'SalesItemLineDetail',
            Description: 'Urethane injection of vertical crack.',
            Amount: 1175,
            SalesItemLineDetail: { ItemRef: { value: '7' }, Qty: 1, UnitPrice: 1175 },
          },
        ],
        privateNote: 'drafter v1 reasoning',
      });

      expect(estimate.Id).toBe('901');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/estimate?minorversion=70');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.TxnStatus).toBe('Pending');
      expect(body.CustomerRef).toEqual({ value: '42' });
      expect(body.Line).toHaveLength(2);
      expect(body.Line[0].DetailType).toBe('DescriptionOnly');
      expect(body.PrivateNote).toBe('drafter v1 reasoning');
      expect(body.BillEmail).toBeUndefined();
    });

    it('passes docNumber through (custom txn numbers mean QBO assigns nothing)', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: '903', SyncToken: '0', DocNumber: '1554', CustomerRef: { value: '42' }, Line: [] },
      }));
      await client.createEstimate({
        customerId: '42',
        lines: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: '7' } } }],
        docNumber: '1554',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.DocNumber).toBe('1554');
    });

    it('truncates the private note to 4000 chars and throws when QBO returns no estimate', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: '902', SyncToken: '0', CustomerRef: { value: '42' }, Line: [] },
      }));
      await client.createEstimate({
        customerId: '42',
        lines: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: '7' } } }],
        privateNote: 'x'.repeat(5000),
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.PrivateNote).toHaveLength(4000);

      mockFetch.mockReturnValueOnce(mockResponse({}));
      await expect(
        client.createEstimate({
          customerId: '42',
          lines: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: '7' } } }],
        }),
      ).rejects.toThrow('did not return estimate');
    });
  });

  describe('updateEstimate', () => {
    it('sparse-updates header fields with a fresh SyncToken and never touches Line', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: '2802', SyncToken: '3', CustomerRef: { value: '42' }, Line: [{ Amount: 1 }] },
      }));
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: '2802', SyncToken: '4', DocNumber: '1554', CustomerRef: { value: '42' }, Line: [] },
      }));

      const updated = await client.updateEstimate('2802', { docNumber: '1554' });
      expect(updated.DocNumber).toBe('1554');

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body).toEqual({ Id: '2802', SyncToken: '3', sparse: true, DocNumber: '1554' });
      expect(body.Line).toBeUndefined();
    });
  });

  describe('deleteEstimate', () => {
    it('fetches for a SyncToken then posts operation=delete', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Estimate: { Id: '2802', SyncToken: '5', CustomerRef: { value: '42' }, Line: [] },
      }));
      mockFetch.mockReturnValueOnce(mockResponse({ Estimate: { Id: '2802', status: 'Deleted' } }));

      await client.deleteEstimate('2802');

      const url = mockFetch.mock.calls[1][0] as string;
      expect(url).toContain('/estimate?operation=delete');
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ Id: '2802', SyncToken: '5' });
    });

    it('is a no-op when the estimate is already gone', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ error: 'not found' }, 404));
      await client.deleteEstimate('9999');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('listItems', () => {
    it('queries active items and returns them', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: {
          Item: [
            { Id: '7', Name: 'Crack Repair', Active: true },
            { Id: '12', Name: 'Guarantee', Active: true },
          ],
        },
      }));

      const items = await client.listItems();
      expect(items.map((i) => i.Name)).toEqual(['Crack Repair', 'Guarantee']);
      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain('FROM Item WHERE Active = true');
    });

    it('returns empty array when QBO has no items', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: {} }));
      expect(await client.listItems()).toEqual([]);
    });
  });

  describe('listAllCustomers', () => {
    it('pages via STARTPOSITION until a short page', async () => {
      const client = makeClient();
      const fullPage = Array.from({ length: 1000 }, (_, i) => ({
        Id: String(i + 1),
        DisplayName: `C${i + 1}`,
      }));
      mockFetch.mockReturnValueOnce(mockResponse({ QueryResponse: { Customer: fullPage } }));
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: { Customer: [{ Id: '1001', DisplayName: 'Last' }] },
      }));

      const customers = await client.listAllCustomers();
      expect(customers).toHaveLength(1001);
      const url1 = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      const url2 = decodeURIComponent(mockFetch.mock.calls[1][0] as string);
      expect(url1).toContain('STARTPOSITION 1 MAXRESULTS 1000');
      expect(url2).toContain('STARTPOSITION 1001 MAXRESULTS 1000');
    });

    it('stops after one page when fewer than the page size', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        QueryResponse: { Customer: [{ Id: '1', DisplayName: 'Only' }] },
      }));
      expect(await client.listAllCustomers()).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
