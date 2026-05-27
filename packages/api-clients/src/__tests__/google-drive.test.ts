import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockFilesGet = vi.fn();
  const MockGoogleAuth = vi.fn();
  const MockOAuth2 = vi.fn(() => ({ setCredentials: vi.fn() }));
  const mockDrive = vi.fn(() => ({ files: { get: mockFilesGet } }));
  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth, OAuth2: MockOAuth2 },
      drive: mockDrive,
    },
    __mocks: { mockFilesGet, MockGoogleAuth, MockOAuth2, mockDrive },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;

import { GoogleDriveClient } from '../google-drive.js';

beforeEach(async () => {
  const googleapis = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks = (googleapis as any).__mocks;
  mocks.mockFilesGet.mockReset();
  mocks.MockOAuth2.mockClear();
  mocks.mockDrive.mockClear();
});

function makeClient() {
  return new GoogleDriveClient({
    oauth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rtok' },
  });
}

describe('GoogleDriveClient', () => {
  describe('config validation', () => {
    it('throws when neither credentials nor oauth provided', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = new GoogleDriveClient({} as any);
      await expect(client.getFileInfo('x')).rejects.toThrow(/requires either/);
    });
  });

  describe('getFileInfo', () => {
    it('returns mapped DriveFileInfo on success', async () => {
      mocks.mockFilesGet.mockResolvedValueOnce({
        data: {
          id: 'F1',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220',
          owners: [{ emailAddress: 'matt@x.com', displayName: 'Matt' }],
          lastModifyingUser: { emailAddress: 'mike@x.com' },
        },
      });

      const info = await makeClient().getFileInfo('F1');
      expect(info).toEqual({
        id: 'F1',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220',
        ownerEmail: 'matt@x.com',
        ownerDisplayName: 'Matt',
        lastModifiedByEmail: 'mike@x.com',
      });
    });

    it('returns null when Drive throws (404, perms, etc)', async () => {
      mocks.mockFilesGet.mockRejectedValueOnce(new Error('boom'));
      const info = await makeClient().getFileInfo('F1');
      expect(info).toBeNull();
    });

    it('requests the correct fields', async () => {
      mocks.mockFilesGet.mockResolvedValueOnce({ data: { id: 'F1', name: 'x' } });
      await makeClient().getFileInfo('F1');
      expect(mocks.mockFilesGet).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'F1',
          fields: expect.stringContaining('owners(emailAddress,displayName)'),
        }),
      );
    });
  });

  describe('resizeThumbnail', () => {
    it('replaces =s{N} with the new size', () => {
      expect(GoogleDriveClient.resizeThumbnail('https://x/abc=s220', 800))
        .toBe('https://x/abc=s800');
    });

    it('replaces =s{N}-crop variants too', () => {
      expect(GoogleDriveClient.resizeThumbnail('https://x/abc=s220-c', 400))
        .toBe('https://x/abc=s400');
    });
  });
});
