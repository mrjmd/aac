/**
 * collectStubPhotoAttachments — replicate Matt's manual photo workflow
 * for auto-created stub events: pull the customer's recent MMS photos
 * from the Quo thread, upload them to Drive, share them with the
 * technician, and return Calendar-ready attachment descriptors.
 *
 * Everything here is a nice-to-have: any failure (expired signed URL,
 * Drive quota, missing scope) logs and degrades to fewer/zero photos —
 * it must never block stub creation. The caller decides what to do with
 * an empty result (create the stub without attachments).
 */

import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import type { QuoClient } from '@aac/api-clients/quo';
import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('scheduling:stub-photos');

/** Mirror of CreateEventInput['attachments'] elements. */
export interface StubPhotoAttachment {
  fileUrl: string;
  title: string;
  mimeType: string;
}

/** One photo's bytes, ready for the Drive upload leg. */
export interface PhotoUploadItem {
  data: ArrayBuffer | Buffer;
  mimeType: string;
  name: string;
}

export const DEFAULT_PHOTO_FOLDER = 'AAC Job Photos (auto)';

/**
 * Shared Drive leg for every photo source (Quo MMS, field app, email):
 * upload each item into the folder, share with the technician(s), return
 * Calendar-ready attachment descriptors. Per-item failures are logged and
 * skipped — partial results beat none.
 */
export async function uploadPhotoAttachments(
  drive: GoogleDriveClient,
  input: {
    items: PhotoUploadItem[];
    shareWithEmails: string[];
    folderName?: string;
  },
): Promise<StubPhotoAttachment[]> {
  if (input.items.length === 0) return [];
  const folderId = await drive.ensureFolder(input.folderName ?? DEFAULT_PHOTO_FOLDER);
  const attachments: StubPhotoAttachment[] = [];
  for (const item of input.items) {
    try {
      const uploaded = await drive.uploadFile({
        name: item.name,
        mimeType: item.mimeType,
        data: item.data,
        folderId,
      });
      if (input.shareWithEmails.length > 0) {
        await drive.shareWithUsers(uploaded.id, input.shareWithEmails);
      }
      attachments.push({ fileUrl: uploaded.fileUrl, title: item.name, mimeType: item.mimeType });
    } catch (err) {
      log.warn('Photo upload failed — skipping photo', {
        name: item.name,
        error: (err as Error).message,
      });
    }
  }
  return attachments;
}

/**
 * Merge attachments from multiple sources in priority order, dropping
 * exact title duplicates (same photo arriving via two channels) and
 * capping the total — Matt reviews stubs on a phone; a wall of photos
 * stops being information.
 */
export function mergePhotoAttachments(
  sources: StubPhotoAttachment[][],
  maxTotal = 12,
): StubPhotoAttachment[] {
  const seen = new Set<string>();
  const merged: StubPhotoAttachment[] = [];
  for (const source of sources) {
    for (const att of source) {
      if (seen.has(att.title)) continue;
      seen.add(att.title);
      merged.push(att);
      if (merged.length >= maxTotal) return merged;
    }
  }
  return merged;
}

export interface CollectStubPhotosDeps {
  quo: QuoClient;
  drive: GoogleDriveClient;
  now: () => Date;
}

export interface CollectStubPhotosInput {
  /** E.164 of the customer whose thread to scan. */
  customerPhone: string;
  /** Drive read access granted to these emails (Mike) — no notification. */
  shareWithEmails: string[];
  /** Cap on photos attached (default 6, most recent kept). */
  maxPhotos?: number;
  /** How far back in the thread to look (default 60 days). */
  sinceDays?: number;
  /** Drive folder the uploads land in (created if missing). */
  folderName?: string;
}

const DEFAULT_MAX_PHOTOS = 6;
const DEFAULT_SINCE_DAYS = 60;
const MESSAGE_SCAN_LIMIT = 50;

function isImage(type: string | undefined, url: string): boolean {
  if (type) return type.startsWith('image/');
  return /\.(jpe?g|png|gif|webp|heic)(\?|$)/i.test(url);
}

/** File name from the media URL path — matches Quo's media id naming. */
function mediaFileName(url: string, fallbackIndex: number): string {
  try {
    const base = new URL(url).pathname.split('/').pop();
    if (base) return base;
  } catch {
    // fall through
  }
  return `photo-${fallbackIndex + 1}.jpg`;
}

export async function collectStubPhotoAttachments(
  deps: CollectStubPhotosDeps,
  input: CollectStubPhotosInput,
): Promise<StubPhotoAttachment[]> {
  const maxPhotos = input.maxPhotos ?? DEFAULT_MAX_PHOTOS;
  const sinceMs =
    deps.now().getTime() - (input.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000;

  try {
    const page = await deps.quo.listMessages({
      participantE164: input.customerPhone,
      maxResults: MESSAGE_SCAN_LIMIT,
    });

    // Customer-sent images in the window, oldest first; keep the most
    // recent `maxPhotos` (latest photos describe the current problem).
    const candidates = (page.data ?? [])
      .filter(
        (m) =>
          m.direction === 'incoming' &&
          new Date(m.createdAt).getTime() >= sinceMs &&
          (m.media?.length ?? 0) > 0,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((m) => m.media ?? [])
      .filter((media) => isImage(media.type, media.url))
      .slice(-maxPhotos);

    if (candidates.length === 0) return [];

    const items: PhotoUploadItem[] = [];
    for (const [i, media] of candidates.entries()) {
      try {
        const downloaded = await deps.quo.downloadMessageMedia(media.url);
        if (!downloaded) {
          log.warn('Stub photo download returned non-OK — skipping', {
            customerPhone: input.customerPhone,
          });
          continue;
        }
        items.push({
          data: downloaded.data,
          mimeType: media.type ?? downloaded.contentType,
          name: mediaFileName(media.url, i),
        });
      } catch (err) {
        log.warn('Stub photo download failed — skipping photo', {
          customerPhone: input.customerPhone,
          error: (err as Error).message,
        });
      }
    }

    const attachments = await uploadPhotoAttachments(deps.drive, {
      items,
      shareWithEmails: input.shareWithEmails,
      folderName: input.folderName,
    });

    log.info('Stub photos collected', {
      customerPhone: input.customerPhone,
      candidates: candidates.length,
      attached: attachments.length,
    });
    return attachments;
  } catch (err) {
    log.warn('Stub photo collection failed — continuing without photos', {
      customerPhone: input.customerPhone,
      error: (err as Error).message,
    });
    return [];
  }
}
