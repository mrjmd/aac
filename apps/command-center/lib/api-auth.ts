import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE_NAME } from "./session";

/**
 * Route-level session check for /api/* handlers. The middleware already
 * gates these paths, but middleware-bypass bugs (Next.js advisories fixed
 * in 15.5.16/15.5.18) make it a single point of failure, so every route
 * re-checks the Redis session itself.
 *
 * Returns a 401 response to send back, or null when the session is valid:
 *   const denied = await requireApiSession(request);
 *   if (denied) return denied;
 */
export async function requireApiSession(request: NextRequest): Promise<NextResponse | null> {
  const session = await readSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return session ? null : NextResponse.json({ error: "Not signed in" }, { status: 401 });
}
