/**
 * Two callers are legitimate:
 *  - Vercel cron (tick/sweep): `authorization: Bearer ${CRON_SECRET}`
 *  - middleware fast lane (draft-followup): `x-worker-secret` shared secret
 * Both secrets required in env; endpoints fail closed when unset.
 */

import { hasBearerSecret, hasHeaderSecret } from '@aac/shared-utils/request-secret';

export function isCronRequest(request: Request): boolean {
  return hasBearerSecret(request.headers.get('authorization'), process.env.CRON_SECRET);
}

export function isMiddlewareRequest(request: Request): boolean {
  return hasHeaderSecret(request.headers.get('x-worker-secret'), process.env.WORKER_SHARED_SECRET);
}

export function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
