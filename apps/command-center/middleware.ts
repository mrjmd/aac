import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/health", "/api/auth"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Static assets and fonts
  if (pathname.startsWith("/_next") || pathname.startsWith("/fonts")) {
    return NextResponse.next();
  }

  const session = request.cookies.get("aac-session");
  if (!session?.value) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
