import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockFilesGet = vi.fn();
  const mockFilesList = vi.fn();
  const mockFilesCreate = vi.fn();
  const mockPermissionsCreate = vi.fn();
  const MockGoogleAuth = vi.fn();
  const MockOAuth2 = vi.fn(() => ({ setCredentials: vi.fn() }));
  const mockDrive = vi.fn(() => ({
    files: { get: mockFilesGet, list: mockFilesList, create: mockFilesCreate },
    permissions: { create: mockPermissionsCreate },
  }));
  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth, OAuth2: MockOAuth2 },
      drive: mockDrive,
    },
    __mocks: {
      mockFilesGet, mockFilesList, mockFilesCreate, mockPermissionsCreate,
      MockGoogleAuth, MockOAuth2, mockDrive,
    },
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
  mocks.mockFilesList.mockReset();
  mocks.mockFilesCreate.mockReset();
  mocks.mockPermissionsCreate.mockReset();
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

  describe('ensureFolder', () => {
    it('returns the existing folder id when found', async () => {
      mocks.mockFilesList.mockResolvedValueOnce({ data: { files: [{ id: 'FOLDER1' }] } });

      await expect(makeClient().ensureFolder('AAC Stub Photos')).resolves.toBe('FOLDER1');
      expect(mocks.mockFilesCreate).not.toHaveBeenCalled();
      expect(mocks.mockFilesList.mock.calls[0][0].q).toContain("name = 'AAC Stub Photos'");
    });

    it('creates the folder when missing', async () => {
      mocks.mockFilesList.mockResolvedValueOnce({ data: { files: [] } });
      mocks.mockFilesCreate.mockResolvedValueOnce({ data: { id: 'NEWFOLDER' } });

      await expect(makeClient().ensureFolder('AAC Stub Photos')).resolves.toBe('NEWFOLDER');
      expect(mocks.mockFilesCreate.mock.calls[0][0].requestBody.mimeType)
        .toBe('application/vnd.google-apps.folder');
    });

    it('escapes quotes in the folder name query', async () => {
      mocks.mockFilesList.mockResolvedValueOnce({ data: { files: [{ id: 'F' }] } });

      await makeClient().ensureFolder("O'Brien");
      expect(mocks.mockFilesList.mock.calls[0][0].q).toContain("O\\'Brien");
    });
  });

  describe('uploadFile', () => {
    it('uploads bytes and returns the drive.google.com/open URL', async () => {
      mocks.mockFilesCreate.mockResolvedValueOnce({ data: { id: 'FILE9' } });

      const result = await makeClient().uploadFile({
        name: 'crack.jpg',
        mimeType: 'image/jpeg',
        data: new Uint8Array([9, 9]).buffer,
        folderId: 'FOLDER1',
      });

      expect(result).toEqual({ id: 'FILE9', fileUrl: 'https://drive.google.com/open?id=FILE9' });
      const call = mocks.mockFilesCreate.mock.calls[0][0];
      expect(call.requestBody.parents).toEqual(['FOLDER1']);
      expect(call.media.mimeType).toBe('image/jpeg');
    });

    it('throws when Drive returns no id', async () => {
      mocks.mockFilesCreate.mockResolvedValueOnce({ data: {} });

      await expect(
        makeClient().uploadFile({ name: 'x.jpg', mimeType: 'image/jpeg', data: new ArrayBuffer(1) }),
      ).rejects.toThrow('no file id');
    });
  });

  describe('shareWithUsers', () => {
    it('creates a reader permission per email without notifications', async () => {
      mocks.mockPermissionsCreate.mockResolvedValue({ data: {} });

      await makeClient().shareWithUsers('FILE9', ['mike@attackacrack.com']);

      expect(mocks.mockPermissionsCreate).toHaveBeenCalledTimes(1);
      expect(mocks.mockPermissionsCreate.mock.calls[0][0]).toEqual({
        fileId: 'FILE9',
        sendNotificationEmail: false,
        requestBody: { type: 'user', role: 'reader', emailAddress: 'mike@attackacrack.com' },
      });
    });
  });
});
