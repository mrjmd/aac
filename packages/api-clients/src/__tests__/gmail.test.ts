import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockMessagesList = vi.fn();
  const mockMessagesGet = vi.fn();
  const mockGetProfile = vi.fn();
  const MockOAuth2 = vi.fn(() => ({
    setCredentials: vi.fn(),
  }));
  const mockGmail = vi.fn(() => ({
    users: {
      messages: { list: mockMessagesList, get: mockMessagesGet },
      getProfile: mockGetProfile,
    },
  }));

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: mockGmail,
    },
    __mocks: { mockMessagesList, mockMessagesGet, mockGetProfile, MockOAuth2, mockGmail },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;

import { GmailClient } from '../gmail.js';

const config = {
  oauth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' },
};

const b64url = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

beforeEach(async () => {
  const googleapis = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks = (googleapis as any).__mocks;
  mocks.mockMessagesList.mockReset();
  mocks.mockMessagesGet.mockReset();
  mocks.mockGetProfile.mockReset();
});

describe('GmailClient.listMessages', () => {
  it('lists ids then fetches full messages with decoded plain-text bodies', async () => {
    mocks.mockMessagesList.mockResolvedValue({
      data: { messages: [{ id: 'm1' }] },
    });
    mocks.mockMessagesGet.mockResolvedValue({
      data: {
        id: 'm1',
        threadId: 't1',
        internalDate: '1791335260000',
        labelIds: ['INBOX', 'IMPORTANT'],
        snippet: 'Photo attached of a settling crack…',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Boris Revsin <boris@example.com>' },
            { name: 'To', value: 'Matt <matt@attackacrack.com>' },
            { name: 'Subject', value: 'Foundation crack repair quote - Newton' },
          ],
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64url('Hi, quote please.') } },
                { mimeType: 'text/html', body: { data: b64url('<p>Hi</p>') } },
              ],
            },
            {
              mimeType: 'image/jpeg',
              filename: 'crack.jpg',
              body: { attachmentId: 'att1' },
            },
          ],
        },
      },
    });

    const client = new GmailClient(config);
    const messages = await client.listMessages({ query: 'newer_than:21d' });

    expect(mocks.mockMessagesList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', q: 'newer_than:21d' }),
    );
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.fromAddress).toBe('boris@example.com');
    expect(m.to).toEqual(['matt@attackacrack.com']);
    expect(m.subject).toBe('Foundation crack repair quote - Newton');
    expect(m.at).toBe('2026-10-07T01:07:40.000Z');
    expect(m.body).toBe('Hi, quote please.');
    expect(m.attachmentNames).toEqual(['crack.jpg']);
  });

  it('paginates the id listing and respects maxResults', async () => {
    mocks.mockMessagesList
      .mockResolvedValueOnce({
        data: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
      })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'c' }] } });
    mocks.mockMessagesGet.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ data: { id, threadId: `t-${id}`, payload: { headers: [] } } }),
    );

    const client = new GmailClient(config);
    const messages = await client.listMessages({ query: 'x', maxResults: 3 });

    expect(messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(mocks.mockMessagesList).toHaveBeenCalledTimes(2);
  });

  it('handles messages with no plain-text part', async () => {
    mocks.mockMessagesList.mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
    mocks.mockMessagesGet.mockResolvedValue({
      data: {
        id: 'm1',
        threadId: 't1',
        payload: {
          headers: [{ name: 'From', value: 'noreply@example.com' }],
          mimeType: 'text/html',
          body: { data: b64url('<p>html only</p>') },
        },
        snippet: 'html only',
      },
    });

    const client = new GmailClient(config);
    const [m] = await client.listMessages({ query: 'x' });
    expect(m.body).toBe('');
    expect(m.snippet).toBe('html only');
    expect(m.fromAddress).toBe('noreply@example.com');
  });
});

describe('GmailClient.getProfileEmail', () => {
  it('returns the lowercased account address', async () => {
    mocks.mockGetProfile.mockResolvedValue({ data: { emailAddress: 'Matt@AttackACrack.com' } });
    const client = new GmailClient(config);
    expect(await client.getProfileEmail()).toBe('matt@attackacrack.com');
  });
});
