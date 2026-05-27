/**
 * Issues short-lived upload tokens for direct browser → Vercel Blob uploads.
 *
 * The client calls @vercel/blob/client `upload()`, which POSTs here to
 * exchange the file path for a signed upload URL. Photo bytes never pass
 * through this serverless function, sidestepping the body-size limit.
 */

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // TODO: gate via session auth once magic-link auth ships.
        // For now, only restrict by the path prefix we own.
        if (!pathname.startsWith('field/')) {
          throw new Error('Upload path must begin with "field/"');
        }
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
          maximumSizeInBytes: 20 * 1024 * 1024,
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
