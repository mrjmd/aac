/**
 * Issues short-lived upload tokens for direct browser → Vercel Blob uploads.
 *
 * The client calls @vercel/blob/client `upload()`, which POSTs here to
 * exchange the file path for a signed upload URL. Photo bytes never pass
 * through this serverless function, sidestepping the body-size limit.
 */

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { createLogger } from '@aac/shared-utils/logger';
import { getCurrentSession } from '@/lib/session';

const log = createLogger('field:photo-upload');

export async function POST(request: Request): Promise<NextResponse> {
  // Belt-and-suspenders: middleware already gated by cookie presence; here we
  // verify the cookie maps to an actual session in Redis before issuing a
  // signed upload URL.
  const session = await getCurrentSession();
  if (!session) {
    log.warn('Upload token rejected: no session');
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('field/')) {
          log.warn('Upload token rejected: bad pathname', { email: session.email, pathname });
          throw new Error('Upload path must begin with "field/"');
        }
        log.info('Issued upload token', { email: session.email, pathname });
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
      onUploadCompleted: async ({ blob }) => {
        // Webhook fired by Vercel Blob after the direct-from-browser upload
        // finishes. Recording is still the server action's job; this log
        // exists so Matt can confirm each photo actually landed in Blob
        // during live tests, separate from whether the form action ran.
        log.info('Photo landed in Blob', { url: blob.url, pathname: blob.pathname });
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    log.error('photo-upload handler failed', err as Error);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
