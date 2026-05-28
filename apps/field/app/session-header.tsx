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
          <Link
            href="/settings"
            aria-label="Settings"
            className="flex items-center gap-2 rounded-full border border-aac-blue/20 px-2 py-1 text-sm hover:bg-aac-blue/5"
          >
            {session.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.picture}
                alt=""
                className="h-7 w-7 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-aac-blue/10 text-xs font-semibold text-aac-blue">
                {initials(session.name)}
              </span>
            )}
            <GearIcon className="h-3.5 w-3.5 text-aac-blue/70" />
          </Link>
        ) : null}
      </div>
    </header>
  );
}

function initials(full: string): string {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M19.4 13c.04-.33.06-.66.06-1s-.02-.67-.06-1l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.03 7.03 0 0 0-1.73-1l-.38-2.65A.49.49 0 0 0 13.93 2h-3.86a.49.49 0 0 0-.5.42l-.38 2.65c-.63.25-1.21.58-1.73 1l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.6 11c-.04.33-.06.66-.06 1s.02.67.06 1l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.42 1.1.75 1.73 1l.38 2.65c.05.24.26.42.5.42h3.86c.24 0 .45-.18.5-.42l.38-2.65c.63-.25 1.21-.58 1.73-1l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}
