import { describe, it, expect, vi } from 'vitest';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import type { QuoClient } from '@aac/api-clients/quo';
import {
  collectStubPhotoAttachments,
  type CollectStubPhotosDeps,
} from '../src/stub-photos.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');

const MEDIA_URL = (id: string) =>
  `https://share.quo.com/v1/resource/message-media/${id}.jpg?sig=abc`;

function makeMessage(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    to: ['+16176681677'],
    from: '+16175550123',
    text: '',
    phoneNumberId: 'pn1',
    direction: 'incoming',
    status: 'delivered',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(messages: unknown[]): {
  deps: CollectStubPhotosDeps;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const listMessages = vi.fn().mockResolvedValue({ data: messages });
  const downloadMessageMedia = vi.fn().mockResolvedValue({
    data: new Uint8Array([1]).buffer,
    contentType: 'image/jpeg',
  });
  const ensureFolder = vi.fn().mockResolvedValue('FOLDER1');
  const uploadFile = vi.fn().mockImplementation(({ name }: { name: string }) =>
    Promise.resolve({ id: `id-${name}`, fileUrl: `https://drive.google.com/open?id=id-${name}` }),
  );
  const shareWithUsers = vi.fn().mockResolvedValue(undefined);

  return {
    deps: {
      quo: { listMessages, downloadMessageMedia } as unknown as QuoClient,
      drive: { ensureFolder, uploadFile, shareWithUsers } as unknown as GoogleDriveClient,
      now: () => NOW,
    },
    mocks: { listMessages, downloadMessageMedia, ensureFolder, uploadFile, shareWithUsers },
  };
}

const INPUT = {
  customerPhone: '+16175550123',
  shareWithEmails: ['mike@attackacrack.com'],
};

describe('collectStubPhotoAttachments', () => {
  it('uploads incoming photos and returns calendar attachments', async () => {
    const { deps, mocks } = makeDeps([
      makeMessage({ media: [{ url: MEDIA_URL('aaa'), type: 'image/jpeg' }] }),
    ]);

    const result = await collectStubPhotoAttachments(deps, INPUT);

    expect(result).toEqual([
      {
        fileUrl: 'https://drive.google.com/open?id=id-aaa.jpg',
        title: 'aaa.jpg',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(mocks.ensureFolder).toHaveBeenCalledWith('AAC Job Photos (auto)');
    expect(mocks.shareWithUsers).toHaveBeenCalledWith('id-aaa.jpg', ['mike@attackacrack.com']);
  });

  it('ignores outgoing messages, old messages, and non-images', async () => {
    const { deps, mocks } = makeDeps([
      makeMessage({ direction: 'outgoing', media: [{ url: MEDIA_URL('out'), type: 'image/jpeg' }] }),
      makeMessage({ createdAt: '2026-06-01T12:00:00.000Z', media: [{ url: MEDIA_URL('old'), type: 'image/jpeg' }] }),
      makeMessage({ media: [{ url: 'https://share.quo.com/v1/resource/message-media/doc.pdf?sig=x', type: 'application/pdf' }] }),
    ]);

    const result = await collectStubPhotoAttachments(deps, INPUT);

    expect(result).toEqual([]);
    expect(mocks.ensureFolder).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it('caps at maxPhotos, keeping the most recent', async () => {
    const msgs = ['a', 'b', 'c'].map((id, i) =>
      makeMessage({
        createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
        media: [{ url: MEDIA_URL(id), type: 'image/jpeg' }],
      }),
    );
    const { deps } = makeDeps(msgs);

    const result = await collectStubPhotoAttachments(deps, { ...INPUT, maxPhotos: 2 });

    expect(result.map((a) => a.title)).toEqual(['b.jpg', 'c.jpg']);
  });

  it('skips a photo whose signed URL has expired (download null)', async () => {
    const { deps, mocks } = makeDeps([
      makeMessage({
        media: [
          { url: MEDIA_URL('dead'), type: 'image/jpeg' },
          { url: MEDIA_URL('live'), type: 'image/jpeg' },
        ],
      }),
    ]);
    mocks.downloadMessageMedia
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: new ArrayBuffer(1), contentType: 'image/jpeg' });

    const result = await collectStubPhotoAttachments(deps, INPUT);

    expect(result.map((a) => a.title)).toEqual(['live.jpg']);
  });

  it('returns [] when the thread fetch throws (never blocks stub creation)', async () => {
    const { deps, mocks } = makeDeps([]);
    mocks.listMessages.mockRejectedValueOnce(new Error('Quo 500'));

    await expect(collectStubPhotoAttachments(deps, INPUT)).resolves.toEqual([]);
  });

  it('continues past a single failed upload', async () => {
    const { deps, mocks } = makeDeps([
      makeMessage({
        media: [
          { url: MEDIA_URL('boom'), type: 'image/jpeg' },
          { url: MEDIA_URL('fine'), type: 'image/jpeg' },
        ],
      }),
    ]);
    mocks.uploadFile
      .mockRejectedValueOnce(new Error('Drive quota'))
      .mockResolvedValueOnce({ id: 'id-fine.jpg', fileUrl: 'https://drive.google.com/open?id=id-fine.jpg' });

    const result = await collectStubPhotoAttachments(deps, INPUT);

    expect(result.map((a) => a.title)).toEqual(['fine.jpg']);
  });
});
