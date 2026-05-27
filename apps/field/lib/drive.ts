/**
 * Helpers for Google Drive attachment URLs returned by the Calendar API.
 */

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
 * Drive's public thumbnail endpoint. Works for files anyone on the device
 * has Google access to (i.e., logged into a Google account that can see the
 * file). For Mike on Android this generally Just Works.
 */
export function driveThumbnailUrl(fileId: string, sizePx = 400): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${sizePx}`;
}
