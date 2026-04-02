import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — factory must not reference outer variables
vi.mock('googleapis', () => {
  const mockRunReport = vi.fn();
  const MockGoogleAuth = vi.fn();
  const mockAnalyticsdata = vi.fn(() => ({
    properties: { runReport: mockRunReport },
  }));

  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth },
      analyticsdata: mockAnalyticsdata,
    },
    // Expose mocks for test access
    __mocks: { mockRunReport, MockGoogleAuth, mockAnalyticsdata },
  };
});

// Access mocks after the hoisted vi.mock has run
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;

import { GoogleAnalyticsClient, type GA4ReportResponse } from '../google-analytics.js';

beforeEach(async () => {
  const googleapis = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks = (googleapis as any).__mocks;
  mocks.mockRunReport.mockReset();
  mocks.MockGoogleAuth.mockReset();
});

function makeClient() {
  return new GoogleAnalyticsClient({
    propertyId: '347942677',
    credentials: { type: 'service_account', project_id: 'test' },
  });
}

describe('GoogleAnalyticsClient', () => {
  describe('runReport', () => {
    it('passes property ID and request body to the API', async () => {
      const client = makeClient();

      mocks.mockRunReport.mockResolvedValueOnce({
        data: {
          dimensionHeaders: [{ name: 'pagePath' }],
          metricHeaders: [{ name: 'eventCount' }],
          rows: [
            {
              dimensionValues: [{ value: '/contact' }],
              metricValues: [{ value: '5' }],
            },
          ],
          rowCount: 1,
        },
      });

      const result = await client.runReport({
        dateRanges: [{ startDate: '14daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'eventCount' }],
      });

      expect(mocks.mockRunReport).toHaveBeenCalledOnce();
      const call = mocks.mockRunReport.mock.calls[0][0];
      expect(call.property).toBe('properties/347942677');
      expect(call.requestBody.dateRanges).toEqual([
        { startDate: '14daysAgo', endDate: 'today' },
      ]);

      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].dimensionValues[0].value).toBe('/contact');
      expect(result.rows[0].metricValues[0].value).toBe('5');
    });

    it('handles empty response', async () => {
      const client = makeClient();

      mocks.mockRunReport.mockResolvedValueOnce({
        data: {
          dimensionHeaders: [],
          metricHeaders: [],
          rows: null,
          rowCount: 0,
        },
      });

      const result = await client.runReport({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      });

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
    });

    it('propagates API errors', async () => {
      const client = makeClient();
      mocks.mockRunReport.mockRejectedValueOnce(new Error('Quota exceeded'));

      await expect(
        client.runReport({
          dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        })
      ).rejects.toThrow('Quota exceeded');
    });

    it('throws when no auth config provided', async () => {
      const client = new GoogleAnalyticsClient({
        propertyId: '347942677',
      });

      await expect(
        client.runReport({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }] })
      ).rejects.toThrow('requires either credentials or oauth');
    });

    it('creates auth with analytics.readonly scope', async () => {
      const client = makeClient();

      mocks.mockRunReport.mockResolvedValueOnce({
        data: {
          dimensionHeaders: [],
          metricHeaders: [],
          rows: [],
          rowCount: 0,
        },
      });

      await client.runReport({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      });

      expect(mocks.MockGoogleAuth).toHaveBeenCalledWith({
        credentials: { type: 'service_account', project_id: 'test' },
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      });
    });
  });

  describe('parseRows', () => {
    it('converts response into flat objects', () => {
      const client = makeClient();

      const response: GA4ReportResponse = {
        dimensionHeaders: [{ name: 'pagePath' }, { name: 'eventName' }],
        metricHeaders: [{ name: 'eventCount' }],
        rows: [
          {
            dimensionValues: [{ value: '/contact' }, { value: 'phone_call_click' }],
            metricValues: [{ value: '12' }],
          },
          {
            dimensionValues: [{ value: '/about' }, { value: 'phone_call_click' }],
            metricValues: [{ value: '3' }],
          },
        ],
        rowCount: 2,
      };

      const parsed = client.parseRows(response);

      expect(parsed).toEqual([
        { pagePath: '/contact', eventName: 'phone_call_click', eventCount: 12 },
        { pagePath: '/about', eventName: 'phone_call_click', eventCount: 3 },
      ]);
    });

    it('converts float metrics correctly', () => {
      const client = makeClient();

      const response: GA4ReportResponse = {
        dimensionHeaders: [{ name: 'pagePath' }],
        metricHeaders: [{ name: 'bounceRate' }],
        rows: [
          {
            dimensionValues: [{ value: '/' }],
            metricValues: [{ value: '0.45' }],
          },
        ],
        rowCount: 1,
      };

      const parsed = client.parseRows(response);
      expect(parsed[0].bounceRate).toBe(0.45);
    });

    it('handles empty rows', () => {
      const client = makeClient();

      const response: GA4ReportResponse = {
        dimensionHeaders: [{ name: 'pagePath' }],
        metricHeaders: [{ name: 'sessions' }],
        rows: [],
        rowCount: 0,
      };

      const parsed = client.parseRows(response);
      expect(parsed).toEqual([]);
    });
  });
});
