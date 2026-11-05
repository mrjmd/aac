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

  it('uploads click conversions with partialFailure on', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ gclid: 'g1' }] }));
    const res = await makeClient().uploadClickConversions([
      {
        gclid: 'g1',
        conversionAction: 'customers/4683607368/conversionActions/1',
        conversionDateTime: '2026-11-05 14:03:00-05:00',
        orderId: 'lead:6175551234',
      },
    ]);
    expect(res.results).toEqual([{ gclid: 'g1' }]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://googleads.googleapis.com/v23/customers/4683607368:uploadClickConversions');
    expect(JSON.parse(init.body)).toMatchObject({ partialFailure: true });
    expect(JSON.parse(init.body).validateOnly).toBeUndefined();
  });

  it('skips the network for an empty upload', async () => {
    expect(await makeClient().uploadClickConversions([])).toEqual({ results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
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

  describe('formatConversionDateTime', () => {
    it('uses the Eastern offset (EST and EDT)', () => {
      expect(GoogleAdsClient.formatConversionDateTime(new Date('2026-11-05T19:03:07Z'))).toBe(
        '2026-11-05 14:03:07-05:00',
      );
      expect(GoogleAdsClient.formatConversionDateTime(new Date('2026-08-10T04:30:00Z'))).toBe(
        '2026-08-10 00:30:00-04:00',
      );
    });

    it('renders UTC as +00:00', () => {
      expect(GoogleAdsClient.formatConversionDateTime(new Date('2026-08-10T04:30:00Z'), 'UTC')).toBe(
        '2026-08-10 04:30:00+00:00',
      );
    });
  });

  it('reads failed row indexes from a partial failure', () => {
    const failed = GoogleAdsClient.failedIndexes({
      results: [{}, { gclid: 'g2' }],
      partialFailureError: {
        message: 'x',
        details: [
          {
            errors: [
              {
                errorCode: { conversionUploadError: 'EXPIRED_CLICK' },
                location: { fieldPathElements: [{ fieldName: 'conversions', index: 0 }, { fieldName: 'gclid' }] },
              },
            ],
          },
        ],
      },
    });
    expect([...failed]).toEqual([[0, 'EXPIRED_CLICK']]);
  });
});
