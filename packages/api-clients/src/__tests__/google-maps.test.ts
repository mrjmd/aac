import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleMapsClient } from '../google-maps.js';

const originalFetch = globalThis.fetch;

function mockFetchOnce(body: unknown, init: ResponseInit = { status: 200 }) {
  const mock = vi.fn().mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function makeClient() {
  return new GoogleMapsClient({ apiKey: 'TEST_KEY' });
}

describe('GoogleMapsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T13:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('getTravelTime', () => {
    it('returns mapped duration + distance on success', async () => {
      mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: ['B'],
        rows: [
          {
            elements: [
              {
                status: 'OK',
                distance: { value: 19794, text: '12.3 mi' },
                duration: { value: 1380, text: '23 mins' },
              },
            ],
          },
        ],
      });

      const est = await makeClient().getTravelTime('A', 'B');
      expect(est).toEqual({ durationSec: 1380, distanceMeters: 19794 });
    });

    it('uses duration_in_traffic when departureTime is provided', async () => {
      const fetchMock = mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: ['B'],
        rows: [
          {
            elements: [
              {
                status: 'OK',
                distance: { value: 1000, text: '1.0 km' },
                duration: { value: 600, text: '10 mins' },
                duration_in_traffic: { value: 900, text: '15 mins' },
              },
            ],
          },
        ],
      });

      const est = await makeClient().getTravelTime('A', 'B', {
        departureTime: new Date('2026-05-27T14:00:00Z'),
      });
      expect(est).toEqual({ durationSec: 900, distanceMeters: 1000 });

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('departure_time=');
      expect(url).toContain('traffic_model=best_guess');
    });

    it("clamps past departure_time to 'now'", async () => {
      const fetchMock = mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: ['B'],
        rows: [
          { elements: [{ status: 'OK', distance: { value: 1, text: '1' }, duration: { value: 1, text: '1' } }] },
        ],
      });

      // 1 hour in the past
      const pastDate = new Date('2026-05-27T12:00:00Z');
      await makeClient().getTravelTime('A', 'B', { departureTime: pastDate });

      const url = String(fetchMock.mock.calls[0][0]);
      const m = url.match(/departure_time=(\d+)/);
      expect(m).not.toBeNull();
      const nowSec = Math.floor(Date.now() / 1000);
      // Should be clamped to "now" (within a couple seconds)
      expect(Number(m![1])).toBeGreaterThanOrEqual(nowSec);
    });

    it("sends literal 'now' string when departureTime='now'", async () => {
      const fetchMock = mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: ['B'],
        rows: [
          { elements: [{ status: 'OK', distance: { value: 1, text: '1' }, duration: { value: 1, text: '1' } }] },
        ],
      });
      await makeClient().getTravelTime('A', 'B', { departureTime: 'now' });
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('departure_time=now');
    });

    it('encodes origin + destination in the URL', async () => {
      const fetchMock = mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: ['B'],
        rows: [
          { elements: [{ status: 'OK', distance: { value: 1, text: '1' }, duration: { value: 1, text: '1' } }] },
        ],
      });

      await makeClient().getTravelTime('30 Randlett St, Quincy, MA', '15 Main St, Hingham, MA');
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('origins=30+Randlett+St');
      expect(url).toContain('destinations=15+Main+St');
      expect(url).toContain('key=TEST_KEY');
      expect(url).toContain('mode=driving');
      expect(url).toContain('units=imperial');
    });

    it('returns null on network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('boom')) as unknown as typeof fetch;
      const est = await makeClient().getTravelTime('A', 'B');
      expect(est).toBeNull();
    });

    it('returns null on non-200 HTTP response', async () => {
      mockFetchOnce('Internal Server Error', { status: 500 });
      const est = await makeClient().getTravelTime('A', 'B');
      expect(est).toBeNull();
    });

    it('returns null on top-level non-OK status (e.g. REQUEST_DENIED)', async () => {
      mockFetchOnce({
        status: 'REQUEST_DENIED',
        error_message: 'API key invalid',
        origin_addresses: [],
        destination_addresses: [],
        rows: [],
      });
      const est = await makeClient().getTravelTime('A', 'B');
      expect(est).toBeNull();
    });

    it('returns null when the element status is not OK (e.g. NOT_FOUND)', async () => {
      mockFetchOnce({
        status: 'OK',
        origin_addresses: ['A'],
        destination_addresses: [''],
        rows: [{ elements: [{ status: 'NOT_FOUND' }] }],
      });
      const est = await makeClient().getTravelTime('A', 'bogus');
      expect(est).toBeNull();
    });
  });
});
