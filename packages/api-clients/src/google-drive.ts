/**
 * Google Drive client — read-only access to file metadata and thumbnails.
 *
 * Used by apps/field to enrich calendar-attached photos: filter out photos
 * a given technician uploaded themselves (we only want context photos Matt
 * pre-attached), and obtain Drive's signed `thumbnailLink` URLs that work
 * on any device without the viewer being authenticated to Google.
 *
 * Same OAuth modes as GoogleCalendarClient.
 */

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
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
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
}
