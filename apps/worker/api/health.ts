/** Liveness probe (route: /api/health). Unauthenticated, reveals nothing. */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ status: 'ok', app: 'worker' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
