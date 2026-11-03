import { NextResponse, type NextRequest } from "next/server";
import { getSignInClient, issueState, redirectUri, safeReturnTo } from "@/lib/google-signin";

/** GET /auth/google?next=/path — start Google sign-in. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const state = await issueState(safeReturnTo(url.searchParams.get("next")));
  const authorize = getSignInClient().authorizeUrl({
    redirectUri: redirectUri(url.origin),
    state,
  });
  return NextResponse.redirect(authorize);
}
