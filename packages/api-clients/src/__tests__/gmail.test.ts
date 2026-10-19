import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockMessagesList = vi.fn();
  const mockMessagesGet = vi.fn();
  const mockAttachmentsGet = vi.fn();
  const mockGetProfile = vi.fn();
  const mockDraftsCreate = vi.fn();
  const MockOAuth2 = vi.fn(() => ({
    setCredentials: vi.fn(),
  }));
  const mockGmail = vi.fn(() => ({
    users: {
      messages: {
        list: mockMessagesList,
        get: mockMessagesGet,
        attachments: { get: mockAttachmentsGet },
      },
      drafts: { create: mockDraftsCreate },
      getProfile: mockGetProfile,
    },
  }));

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: mockGmail,
    },
    __mocks: {
      mockMessagesList,
      mockMessagesGet,
      mockAttachmentsGet,
      mockGetProfile,
      mockDraftsCreate,
      MockOAuth2,
      mockGmail,
    },
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
  mocks.mockAttachmentsGet.mockReset();
  mocks.mockGetProfile.mockReset();
  mocks.mockDraftsCreate.mockReset();
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
              body: { attachmentId: 'att1', size: 123456 },
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
    expect(m.attachments).toEqual([
      { attachmentId: 'att1', filename: 'crack.jpg', mimeType: 'image/jpeg', sizeBytes: 123456 },
    ]);
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

describe('GmailClient.downloadAttachment', () => {
  it('decodes base64url attachment bytes', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    mocks.mockAttachmentsGet.mockResolvedValue({
      data: { data: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') },
    });

    const client = new GmailClient(config);
    const result = await client.downloadAttachment('m1', 'att1');

    expect(mocks.mockAttachmentsGet).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'm1',
      id: 'att1',
    });
    expect(result).toEqual(bytes);
  });

  it('returns null when Gmail returns no data', async () => {
    mocks.mockAttachmentsGet.mockResolvedValue({ data: {} });
    const client = new GmailClient(config);
    expect(await client.downloadAttachment('m1', 'gone')).toBeNull();
  });
});

describe('GmailClient.getProfileEmail', () => {
  it('returns the lowercased account address', async () => {
    mocks.mockGetProfile.mockResolvedValue({ data: { emailAddress: 'Matt@AttackACrack.com' } });
    const client = new GmailClient(config);
    expect(await client.getProfileEmail()).toBe('matt@attackacrack.com');
  });
});

describe('GmailClient rate-limit retry', () => {
  const retryConfig = { ...config, retry: { baseDelayMs: 1 } };
  const quotaErr = Object.assign(new Error('Quota exceeded for quota metric'), { code: 429 });

  const fullMessage = {
    data: {
      id: 'm1',
      threadId: 't1',
      internalDate: '1791335260000',
      payload: { headers: [{ name: 'From', value: 'a@b.com' }] },
    },
  };

  it('retries messages.get on 429 and succeeds', async () => {
    mocks.mockMessagesList.mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
    mocks.mockMessagesGet
      .mockRejectedValueOnce(quotaErr)
      .mockRejectedValueOnce(quotaErr)
      .mockResolvedValue(fullMessage);

    const client = new GmailClient(retryConfig);
    const msgs = await client.listMessages({ query: 'x' });
    expect(msgs).toHaveLength(1);
    expect(mocks.mockMessagesGet).toHaveBeenCalledTimes(3);
  });

  it('retries messages.list on 403 quota errors', async () => {
    mocks.mockMessagesList
      .mockRejectedValueOnce(Object.assign(new Error('User rate limit exceeded'), { code: 403 }))
      .mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
    mocks.mockMessagesGet.mockResolvedValue(fullMessage);

    const client = new GmailClient(retryConfig);
    const msgs = await client.listMessages({ query: 'x' });
    expect(msgs).toHaveLength(1);
    expect(mocks.mockMessagesList).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts', async () => {
    mocks.mockMessagesList.mockRejectedValue(quotaErr);
    const client = new GmailClient({ ...config, retry: { baseDelayMs: 1, maxAttempts: 3 } });
    await expect(client.listMessages({ query: 'x' })).rejects.toThrow('Quota exceeded');
    expect(mocks.mockMessagesList).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-rate-limit errors', async () => {
    mocks.mockMessagesList.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 403 }));
    const client = new GmailClient(retryConfig);
    await expect(client.listMessages({ query: 'x' })).rejects.toThrow('Forbidden');
    expect(mocks.mockMessagesList).toHaveBeenCalledTimes(1);
  });
});

describe('GmailClient.createDraft', () => {
  const decodeRaw = (raw: string): string =>
    Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  it('builds a threaded multipart draft with attachments', async () => {
    mocks.mockDraftsCreate.mockResolvedValue({ data: { id: 'd1', message: { id: 'm9' } } });
    const client = new GmailClient(config);
    const res = await client.createDraft({
      to: ['keri@example.com'],
      subject: 'Re: Quote',
      body: 'Hi Keri,\nDocs attached.',
      threadId: 't42',
      inReplyTo: '<orig@mail.gmail.com>',
      attachments: [{ filename: 'w9.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFBYTES') }],
    });

    expect(res).toEqual({ draftId: 'd1', messageId: 'm9' });
    const call = mocks.mockDraftsCreate.mock.calls[0][0];
    expect(call.requestBody.message.threadId).toBe('t42');
    const mime = decodeRaw(call.requestBody.message.raw);
    expect(mime).toContain('To: keri@example.com');
    expect(mime).toContain('Subject: Re: Quote');
    expect(mime).toContain('In-Reply-To: <orig@mail.gmail.com>');
    expect(mime).toContain('References: <orig@mail.gmail.com>');
    expect(mime).toContain('Content-Disposition: attachment; filename="w9.pdf"');
    expect(mime).toContain(Buffer.from('PDFBYTES').toString('base64'));
    expect(mime).toContain(Buffer.from('Hi Keri,\nDocs attached.', 'utf8').toString('base64'));
  });

  it('omits threading headers and threadId when not replying', async () => {
    mocks.mockDraftsCreate.mockResolvedValue({ data: { id: 'd2', message: { id: 'm10' } } });
    const client = new GmailClient(config);
    await client.createDraft({ to: ['a@b.com'], subject: 'Hello', body: 'plain' });

    const call = mocks.mockDraftsCreate.mock.calls[0][0];
    expect(call.requestBody.message.threadId).toBeUndefined();
    const mime = decodeRaw(call.requestBody.message.raw);
    expect(mime).not.toContain('In-Reply-To:');
    expect(mime).not.toContain('References:');
  });
});
