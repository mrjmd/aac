/**
 * Issues short-lived upload tokens for direct browser → Vercel Blob uploads.
 *
 * The client calls @vercel/blob/client `upload()`, which POSTs here to
 * exchange the file path for a signed upload URL. Photo bytes never pass
 * through this serverless function, sidestepping the body-size limit.
 */

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  // Belt-and-suspenders: middleware already gated by cookie presence; here we
  // verify the cookie maps to an actual session in Redis before issuing a
  // signed upload URL.
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('field/')) {
          throw new Error('Upload path must begin with "field/"');
        }
        return {
          allowedContentTypes: [
            'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
            'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
          ],
          // 100 MB cap so a 1–2 minute phone video fits. Vercel Blob will
          // reject anything larger.
          maximumSizeInBytes: 100 * 1024 * 1024,
        };
      },
      onUploadCompleted: async () => {
        // No-op — completion is recorded via the form's server action after the
        // user clicks the next step. Orphans (uploaded but never confirmed)
        // are tolerable for now; future: nightly cleanup of unreferenced blobs.
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    console.error('photo-upload token issuance failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
