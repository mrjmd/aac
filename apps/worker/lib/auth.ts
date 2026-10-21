/**
 * Two callers are legitimate:
 *  - Vercel cron (tick/sweep): `authorization: Bearer ${CRON_SECRET}`
 *  - middleware fast lane (draft-followup): `x-worker-secret` shared secret
 * Both secrets required in env; endpoints fail closed when unset.
 */
export function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export function isMiddlewareRequest(request: Request): boolean {
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return false;
  return request.headers.get('x-worker-secret') === secret;
}

export function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
