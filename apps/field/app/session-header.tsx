/**
 * Brand bar — logo + product name + user chip + sign out. Not sticky, so it
 * doesn't fight with the day-nav header on the jobs list. Renders an empty
 * shell when there's no session so the login page still sees the brand.
 */

import Link from 'next/link';
import { getCurrentSession } from '@/lib/session';

export default async function SessionHeader() {
  const session = await getCurrentSession();

  return (
    <header className="border-b border-aac-blue/15 bg-white">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2">
        <Link href="/" className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.webp"
            alt=""
            className="h-9 w-9 rounded-lg object-cover shadow-[3px_3px_0px_0px_rgba(30,111,184,0.18)]"
          />
          <div className="flex flex-col leading-none">
            <span className="font-display text-base font-black tracking-tight text-aac-dark">
              ATTACK A CRACK
            </span>
            <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.18em] text-aac-blue">
              Field
            </span>
          </div>
        </Link>

        {session ? (
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/bank"
              className="rounded-md border border-aac-blue/20 px-2.5 py-1 text-xs font-medium text-aac-blue hover:bg-aac-blue/5"
            >
              At the bank
            </Link>
            {session.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.picture}
                alt=""
                className="h-7 w-7 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="text-xs font-medium text-aac-dark">{firstName(session.name)}</span>
            )}
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-xs text-aac-dark/60 hover:text-aac-blue"
                aria-label="Sign out"
              >
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] || full;
}
