/**
 * Helpers for Drive attachments referenced from Google Calendar events.
 *
 * The Calendar API returns attachment URLs but no metadata about who
 * uploaded each one. To filter out photos the technician took themselves
 * (we only want context photos Matt pre-attached for Mike to review), we
 * have to call Drive for each file. Results are cached in Redis indefinitely
 * — file ownership doesn't change after upload.
 */

import { GoogleDriveClient, type DriveFileInfo } from '@aac/api-clients/google-drive';
import { keys } from '@aac/shared-utils/redis';
import { getDrive, getRedis } from './clients';

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
      // Cache nulls too with shorter TTL — avoids hammering Drive for permanently-bad IDs
      if (fetched[i]) {
        pipeline.set(keys.driveFileInfo(id), fetched[i]);
      } else {
        pipeline.set(keys.driveFileInfo(id), null, { ex: 86_400 });
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
