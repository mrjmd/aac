/**
 * Sticky bottom CTA bar — mirrors the aac-astro website footer pattern
 * (dark fill, yellow top accent, two thumb-friendly pill buttons).
 *
 * "At the bank" gets the warm primary treatment because it's the action
 * that moves real money out of Mike's pocket and into QBO. "Report issue"
 * is outlined — same prominence, secondary visual weight.
 *
 * Gated on session: renders nothing on /login and other unauthenticated
 * surfaces, so the brand bar isn't competing with a CTA aimed at someone
 * who hasn't signed in yet.
 */

import { headers } from 'next/headers';
import Link from 'next/link';
import { getCurrentSession } from '@/lib/session';

/**
 * Routes where the bar would be redundant or fight the page's own bottom UI:
 * /bank has its own sticky "Create deposit" button.
 */
const HIDE_ON_PATHS = new Set(['/bank']);

export default async function MobileActionBar() {
  const session = await getCurrentSession();
  if (!session) return null;

  const pathname = (await headers()).get('x-pathname') ?? '';
  if (HIDE_ON_PATHS.has(pathname)) return null;

  return (
    <nav
      aria-label="Quick actions"
      className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-aac-yellow bg-aac-dark"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <Link
          href="/bank"
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-aac-yellow px-4 py-3 text-sm font-bold uppercase tracking-wider text-aac-dark shadow-sm active:bg-aac-yellow/85"
        >
          <BankIcon className="h-4 w-4" />
          At the bank
        </Link>
        <Link
          href="/issue"
          className="flex flex-1 items-center justify-center gap-2 rounded-full border border-white/30 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white active:bg-white/10"
        >
          <AlertIcon className="h-4 w-4" />
          Report issue
        </Link>
      </div>
    </nav>
  );
}

function BankIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2 2 7v2h20V7L12 2zm-8 9v6H3v2h18v-2h-1v-6h-2v6h-3v-6h-2v6h-2v-6H9v6H6v-6H4z" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2 1 21h22L12 2zm0 5 7.5 13h-15L12 7zm-1 5v4h2v-4h-2zm0 5v2h2v-2h-2z" />
    </svg>
  );
}
