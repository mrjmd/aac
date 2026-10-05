/**
 * Google Drive client — file metadata, thumbnails, uploads, and sharing.
 *
 * Used by apps/field to enrich calendar-attached photos: filter out photos
 * a given technician uploaded themselves (we only want context photos Matt
 * pre-attached), and obtain Drive's signed `thumbnailLink` URLs that work
 * on any device without the viewer being authenticated to Google.
 *
 * Also used by the scheduling stub pipeline to upload customer MMS photos
 * so they can be attached to calendar events (the Calendar API only
 * accepts Drive files as attachments).
 *
 * Same OAuth modes as GoogleCalendarClient. Uploads require a token with
 * full `drive` scope — in credentials (service-account) mode the default
 * scope is read-only, so pass `scopes` explicitly if uploading.
 */

import { Readable } from 'node:stream';
import { google, type drive_v3 } from 'googleapis';

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('google-drive');

export interface GoogleDriveConfig {
  credentials?: Record<string, unknown>;
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  /** Scopes for credentials mode only (oauth refresh tokens carry their own). */
  scopes?: string[];
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType?: string;
  /** Pre-signed googleusercontent URL — loads without viewer auth. */
  thumbnailLink?: string;
  ownerEmail?: string;
  ownerDisplayName?: string;
  lastModifiedByEmail?: string;
}

export class GoogleDriveClient {
  private _client: drive_v3.Drive | null = null;

  constructor(private config: GoogleDriveConfig) {}

  private async getClient(): Promise<drive_v3.Drive> {
    if (this._client) return this._client;

    let auth;
    if (this.config.oauth) {
      const oauth2 = new google.auth.OAuth2(
        this.config.oauth.clientId,
        this.config.oauth.clientSecret,
      );
      oauth2.setCredentials({ refresh_token: this.config.oauth.refreshToken });
      auth = oauth2;
    } else if (this.config.credentials) {
      auth = new google.auth.GoogleAuth({
        credentials: this.config.credentials,
        scopes: this.config.scopes ?? ['https://www.googleapis.com/auth/drive.readonly'],
      });
    } else {
      throw new Error('GoogleDriveClient requires either credentials or oauth config');
    }

    this._client = google.drive({ version: 'v3', auth });
    return this._client;
  }

  /**
   * Fetch file metadata. Returns null on failure (404, permission, etc.)
   * so callers can degrade gracefully — a missing thumbnail isn't fatal.
   */
  async getFileInfo(fileId: string): Promise<DriveFileInfo | null> {
    const client = await this.getClient();
    try {
      const resp = await client.files.get({
        fileId,
        fields: 'id,name,mimeType,thumbnailLink,owners(emailAddress,displayName),lastModifyingUser(emailAddress)',
      });
      const d = resp.data;
      return {
        id: d.id || fileId,
        name: d.name || '',
        mimeType: d.mimeType || undefined,
        thumbnailLink: d.thumbnailLink || undefined,
        ownerEmail: d.owners?.[0]?.emailAddress || undefined,
        ownerDisplayName: d.owners?.[0]?.displayName || undefined,
        lastModifiedByEmail: d.lastModifyingUser?.emailAddress || undefined,
      };
    } catch (err) {
      log.warn('Drive file fetch failed', { fileId, error: (err as Error).message });
      return null;
    }
  }

  /**
   * Resize a Drive thumbnail link to a different pixel size. Drive's
   * thumbnailLink ends in `=s{N}` where N is the longest-edge size.
   */
  static resizeThumbnail(thumbnailLink: string, sizePx: number): string {
    return thumbnailLink.replace(/=s\d+(-[a-z]+)?$/i, `=s${sizePx}`);
  }

  /**
   * Find a folder by exact name (not trashed), creating it if absent.
   * Returns the folder ID. Name is escaped for the Drive query language.
   */
  async ensureFolder(name: string): Promise<string> {
    const client = await this.getClient();
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const found = await client.files.list({
      q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    });
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await client.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    const id = created.data.id;
    if (!id) throw new Error('Drive folder creation returned no id');
    log.info('Drive folder created', { name, folderId: id });
    return id;
  }

  /**
   * Upload a file. Returns the file ID plus the `drive.google.com/open`
   * URL — the form the Calendar API expects in attachment fileUrl (and
   * the form Calendar's own UI writes).
   */
  async uploadFile(input: {
    name: string;
    mimeType: string;
    data: ArrayBuffer | Buffer;
    folderId?: string;
  }): Promise<{ id: string; fileUrl: string }> {
    const client = await this.getClient();
    const body = Readable.from(
      Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data),
    );
    const res = await client.files.create({
      requestBody: {
        name: input.name,
        ...(input.folderId ? { parents: [input.folderId] } : {}),
      },
      media: { mimeType: input.mimeType, body },
      fields: 'id',
    });
    const id = res.data.id;
    if (!id) throw new Error('Drive upload returned no file id');
    log.info('Drive file uploaded', { name: input.name, fileId: id });
    return { id, fileUrl: `https://drive.google.com/open?id=${id}` };
  }

  /**
   * Grant read access to specific users, without notification emails.
   * Calendar attachments do NOT inherit event sharing — attendees need
   * Drive permission on the file to open it.
   */
  async shareWithUsers(fileId: string, emails: string[]): Promise<void> {
    const client = await this.getClient();
    for (const email of emails) {
      await client.permissions.create({
        fileId,
        sendNotificationEmail: false,
        requestBody: { type: 'user', role: 'reader', emailAddress: email },
      });
    }
  }
}
