/**
 * Tiny top-bar showing the signed-in user + a sign-out button. Server
 * component — reads the session directly so the login page (which has no
 * session) renders no header.
 */

import Link from 'next/link';
import { getCurrentSession } from '@/lib/session';

export default async function SessionHeader() {
  const session = await getCurrentSession();
  if (!session) return null;

  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 text-sm">
      <div className="flex items-center gap-2 text-gray-700">
        {session.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={session.picture} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
        ) : null}
        <span className="font-medium">{session.name}</span>
      </div>
      <div className="flex items-center gap-4">
        <Link href="/bank" className="text-gray-500 hover:text-gray-900">
          At the bank
        </Link>
        <form action="/auth/signout" method="post">
          <button type="submit" className="text-gray-500 hover:text-gray-900">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
