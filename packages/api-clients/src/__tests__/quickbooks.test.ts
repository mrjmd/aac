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

  describe('sendInvoice', () => {
    it('POSTs to /invoice/{id}/send and passes sendTo when email given', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockResponse({
        Invoice: { Id: 'inv-7', SyncToken: '1', CustomerRef: { value: 'c-1' }, Line: [], EmailStatus: 'EmailSent' },
      }));

      const result = await client.sendInvoice('inv-7', 'override@example.com');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/invoice/inv-7/send');
      expect(url).toContain('sendTo=override%40example.com');
      expect((mockFetch.mock.calls[0][1] as { method: string }).method).toBe('POST');
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
});
