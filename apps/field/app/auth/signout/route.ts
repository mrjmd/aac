import { NextResponse, type NextRequest } from 'next/server';
import { destroySession } from '@/lib/session';

/** POST /auth/signout — wipes the session and bounces to /login. */
export async function POST(req: NextRequest) {
  await destroySession();
  return NextResponse.redirect(new URL('/login', req.url));
}
