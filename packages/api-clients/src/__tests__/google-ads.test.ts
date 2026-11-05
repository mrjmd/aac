import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleAdsClient } from '../google-ads.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeClient() {
  return new GoogleAdsClient({
    developerToken: 'dev-token',
    clientId: 'cid',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    customerId: '4683607368',
    loginCustomerId: '9448392141',
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleAdsClient', () => {
  it('refreshes the token once and sends developer + login-customer headers', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([{ results: [{ a: 1 }] }, { results: [{ a: 2 }] }]))
      .mockResolvedValueOnce(jsonResponse([{}]));

    const client = makeClient();
    expect(await client.search('SELECT x FROM y')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await client.search('SELECT x FROM y')).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://googleads.googleapis.com/v23/customers/4683607368/googleAds:searchStream');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'developer-token': 'dev-token',
      'login-customer-id': '9448392141',
    });
    expect(JSON.parse(init.body)).toEqual({ query: 'SELECT x FROM y' });
  });

  it('throws with the status and body on API errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(new Response('bad gaql', { status: 400 }));
    await expect(makeClient().search('nope')).rejects.toThrow(/400.*bad gaql/);
  });

  it('maps conversion action rows', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            results: [
              {
                conversionAction: {
                  resourceName: 'customers/1/conversionActions/9',
                  id: '9',
                  name: 'AAC Real lead',
                  type: 'UPLOAD_CLICKS',
                  status: 'ENABLED',
                  primaryForGoal: false,
                },
              },
            ],
          },
        ]),
      );
    const rows = await makeClient().listConversionActions();
    expect(rows).toEqual([
      {
        resourceName: 'customers/1/conversionActions/9',
        id: '9',
        name: 'AAC Real lead',
        type: 'UPLOAD_CLICKS',
        status: 'ENABLED',
        primaryForGoal: false,
      },
    ]);
  });
});
