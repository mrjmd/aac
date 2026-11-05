import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataManagerClient } from '../data-manager.js';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const client = () => new DataManagerClient({ clientId: 'cid', clientSecret: 's', refreshToken: 'r' });
const dest = [{ reference: 'lead', operatingAccountId: '4683607368', loginAccountId: '9448392141', conversionActionId: '7891297857' }];
const ev = {
  destinationReferences: ['lead'],
  gclid: 'g1',
  eventTimestamp: '2026-11-05T19:00:00.000Z',
  transactionId: 'lead:6175550001',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('DataManagerClient.ingestEvents', () => {
  it('posts Google Ads destinations and gclid events', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tok' })).mockResolvedValueOnce(json({ requestId: 'req-1' }));
    const res = await client().ingestEvents(dest, [ev, { ...ev, transactionId: 'quote:1', conversionValue: 1175 }], { validateOnly: true });
    expect(res.requestId).toBe('req-1');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      destinations: [
        {
          reference: 'lead',
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '4683607368' },
          loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9448392141' },
          productDestinationId: '7891297857',
        },
      ],
      events: [
        { destinationReferences: ['lead'], adIdentifiers: { gclid: 'g1' }, eventTimestamp: ev.eventTimestamp, transactionId: 'lead:6175550001', eventSource: 'WEB' },
        {
          destinationReferences: ['lead'], adIdentifiers: { gclid: 'g1' }, eventTimestamp: ev.eventTimestamp, transactionId: 'quote:1',
          conversionValue: 1175, currency: 'USD', eventSource: 'WEB',
        },
      ],
      validateOnly: true,
    });
  });

  it('throws with the body on a rejected request', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tok' })).mockResolvedValueOnce(new Response('events.events[1] INVALID', { status: 400 }));
    await expect(client().ingestEvents(dest, [ev])).rejects.toThrow(/400.*events\[1\]/);
  });

  it('refuses more than 2,000 events', async () => {
    await expect(client().ingestEvents(dest, Array(2001).fill(ev))).rejects.toThrow(/2,000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
