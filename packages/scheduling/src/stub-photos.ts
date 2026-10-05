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
const DEFAULT_FOLDER = 'AAC Job Photos (auto)';
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

    const folderId = await deps.drive.ensureFolder(
      input.folderName ?? DEFAULT_FOLDER,
    );

    const attachments: StubPhotoAttachment[] = [];
    for (const [i, media] of candidates.entries()) {
      try {
        const downloaded = await deps.quo.downloadMessageMedia(media.url);
        if (!downloaded) {
          log.warn('Stub photo download returned non-OK — skipping', {
            customerPhone: input.customerPhone,
          });
          continue;
        }
        const mimeType = media.type ?? downloaded.contentType;
        const name = mediaFileName(media.url, i);
        const uploaded = await deps.drive.uploadFile({
          name,
          mimeType,
          data: downloaded.data,
          folderId,
        });
        if (input.shareWithEmails.length > 0) {
          await deps.drive.shareWithUsers(uploaded.id, input.shareWithEmails);
        }
        attachments.push({ fileUrl: uploaded.fileUrl, title: name, mimeType });
      } catch (err) {
        log.warn('Stub photo upload failed — skipping photo', {
          customerPhone: input.customerPhone,
          error: (err as Error).message,
        });
      }
    }

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
