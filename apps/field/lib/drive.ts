/**
 * Helpers for Drive attachments referenced from Google Calendar events.
 *
 * The Calendar API returns attachment URLs but no metadata about who
 * uploaded each one. To filter out photos the technician took themselves
 * (we only want context photos Matt pre-attached for Mike to review), we
 * have to call Drive for each file.
 *
 * Cache TTL is intentionally short (30 min) because Drive's `thumbnailLink`
 * is a signed URL that expires — caching it indefinitely returns 403s once
 * the signature lapses. 30 min is well inside Drive's signature window and
 * gives a reasonable cache hit rate for repeat page loads.
 */

import { GoogleDriveClient, type DriveFileInfo } from '@aac/api-clients/google-drive';
import { keys } from '@aac/shared-utils/redis';
import { getDrive, getRedis } from './clients';

const DRIVE_INFO_TTL_SECONDS = 30 * 60;     // 30 min — bounded by Drive's signed URL lifetime
const DRIVE_NULL_TTL_SECONDS = 24 * 60 * 60; // 24h — "this file is gone / inaccessible" doesn't flip back fast

/**
 * Extract the Drive file ID from a calendar attachment fileUrl.
 *
 * Drive serves two URL shapes:
 *   - https://drive.google.com/file/d/{fileId}/view?usp=drivesdk
 *   - https://drive.google.com/open?id={fileId}
 */
export function extractDriveFileId(fileUrl: string): string | null {
  const m1 = fileUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = fileUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

/**
 * Fetch Drive metadata for many file IDs at once. Results come from Redis
 * cache when available, Drive API otherwise. Returns a Map keyed by fileId.
 * Files Drive can't see (deleted, no access, network failure) map to null.
 */
export async function getDriveInfos(
  fileIds: string[],
): Promise<Map<string, DriveFileInfo | null>> {
  const out = new Map<string, DriveFileInfo | null>();
  if (fileIds.length === 0) return out;

  const redis = getRedis();
  const cacheKeys = fileIds.map((id) => keys.driveFileInfo(id));
  const cached = await redis.mget<(DriveFileInfo | null)[]>(...cacheKeys);

  const missing: string[] = [];
  fileIds.forEach((id, i) => {
    if (cached[i] !== null && cached[i] !== undefined) {
      out.set(id, cached[i]);
    } else {
      missing.push(id);
    }
  });

  if (missing.length > 0) {
    const drive = getDrive();
    const fetched = await Promise.all(missing.map((id) => drive.getFileInfo(id)));
    // Write through to cache (Drive metadata doesn't change after upload)
    const pipeline = redis.pipeline();
    missing.forEach((id, i) => {
      out.set(id, fetched[i]);
      if (fetched[i]) {
        pipeline.set(keys.driveFileInfo(id), fetched[i], { ex: DRIVE_INFO_TTL_SECONDS });
      } else {
        pipeline.set(keys.driveFileInfo(id), null, { ex: DRIVE_NULL_TTL_SECONDS });
      }
    });
    await pipeline.exec();
  }

  return out;
}

/**
 * Drive's signed thumbnail URL — works on any device, no viewer auth needed.
 * Optionally resize.
 */
export function thumbnailUrl(info: DriveFileInfo, sizePx = 400): string | undefined {
  if (!info.thumbnailLink) return undefined;
  return GoogleDriveClient.resizeThumbnail(info.thumbnailLink, sizePx);
}
