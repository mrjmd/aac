import { describe, it, expect, vi } from 'vitest';
import type { GmailClient } from '@aac/api-clients/gmail';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import {
  collectEmailPhotoAttachments,
  type CollectEmailPhotosDeps,
} from '../src/email-photos.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function makeEmail(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'Jane <jane@example.com>',
    fromAddress: 'jane@example.com',
    to: ['matt@attackacrack.com'],
    subject: 'Photos of the crack',
    at: '2026-10-10T12:00:00.000Z',
    labelIds: ['INBOX'],
    snippet: '',
    body: 'Photos attached.',
    attachmentNames: [],
    attachments: [],
    ...overrides,
  };
}

function makeDeps(messages: unknown[]): {
  deps: CollectEmailPhotosDeps;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const listMessages = vi.fn().mockResolvedValue(messages);
  const downloadAttachment = vi.fn().mockResolvedValue(Buffer.from([1]));
  const ensureFolder = vi.fn().mockResolvedValue('FOLDER1');
  const uploadFile = vi.fn().mockImplementation(({ name }: { name: string }) =>
    Promise.resolve({ id: `id-${name}`, fileUrl: `https://drive.google.com/open?id=id-${name}` }),
  );
  const shareWithUsers = vi.fn().mockResolvedValue(undefined);

  return {
    deps: {
      gmail: { listMessages, downloadAttachment } as unknown as GmailClient,
      drive: { ensureFolder, uploadFile, shareWithUsers } as unknown as GoogleDriveClient,
      now: () => NOW,
    },
    mocks: { listMessages, downloadAttachment, ensureFolder, uploadFile, shareWithUsers },
  };
}

const INPUT = {
  customerEmails: ['jane@example.com'],
  shareWithEmails: ['mike@attackacrack.com'],
};

describe('collectEmailPhotoAttachments', () => {
  it('searches by sender, downloads image attachments, and uploads them', async () => {
    const { deps, mocks } = makeDeps([
      makeEmail({
        attachments: [
          { attachmentId: 'att1', filename: 'IMG_100.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
          { attachmentId: 'att2', filename: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 200 },
        ],
      }),
    ]);

    const result = await collectEmailPhotoAttachments(deps, INPUT);

    expect(mocks.listMessages).toHaveBeenCalledWith({
      query: 'from:jane@example.com has:attachment newer_than:60d',
      maxResults: 20,
    });
    expect(result).toEqual([
      {
        fileUrl: 'https://drive.google.com/open?id=id-IMG_100.jpg',
        title: 'IMG_100.jpg',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(mocks.downloadAttachment).toHaveBeenCalledWith('m1', 'att1');
    expect(mocks.shareWithUsers).toHaveBeenCalledWith('id-IMG_100.jpg', ['mike@attackacrack.com']);
  });

  it('ORs multiple sender addresses into one query', async () => {
    const { deps, mocks } = makeDeps([]);
    await collectEmailPhotoAttachments(deps, {
      ...INPUT,
      customerEmails: ['jane@example.com', 'jane.work@example.com'],
    });
    expect(mocks.listMessages).toHaveBeenCalledWith({
      query:
        '(from:jane@example.com OR from:jane.work@example.com) has:attachment newer_than:60d',
      maxResults: 20,
    });
  });

  it('returns [] without searching when no customer email is known', async () => {
    const { deps, mocks } = makeDeps([]);
    const result = await collectEmailPhotoAttachments(deps, { ...INPUT, customerEmails: [' '] });
    expect(result).toEqual([]);
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it('caps at maxPhotos keeping the most recent', async () => {
    const { deps } = makeDeps([
      makeEmail({
        id: 'older',
        at: '2026-10-01T12:00:00.000Z',
        attachments: [{ attachmentId: 'a', filename: 'old.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }],
      }),
      makeEmail({
        id: 'newer',
        at: '2026-10-10T12:00:00.000Z',
        attachments: [
          { attachmentId: 'b', filename: 'new-1.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
          { attachmentId: 'c', filename: 'new-2.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
        ],
      }),
    ]);

    const result = await collectEmailPhotoAttachments(deps, { ...INPUT, maxPhotos: 2 });
    expect(result.map((a) => a.title)).toEqual(['new-1.jpg', 'new-2.jpg']);
  });

  it('skips attachments whose download returns null and continues', async () => {
    const { deps, mocks } = makeDeps([
      makeEmail({
        attachments: [
          { attachmentId: 'dead', filename: 'dead.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
          { attachmentId: 'live', filename: 'live.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
        ],
      }),
    ]);
    mocks.downloadAttachment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from([1]));

    const result = await collectEmailPhotoAttachments(deps, INPUT);
    expect(result.map((a) => a.title)).toEqual(['live.jpg']);
  });

  it('returns [] when the Gmail search throws (never blocks stub creation)', async () => {
    const { deps, mocks } = makeDeps([]);
    mocks.listMessages.mockRejectedValueOnce(new Error('Gmail 500'));
    await expect(collectEmailPhotoAttachments(deps, INPUT)).resolves.toEqual([]);
  });
});
