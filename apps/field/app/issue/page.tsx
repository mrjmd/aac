import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

const PLANNED_CATEGORIES = [
  {
    title: 'Running late',
    body: 'Pick how late (5 / 15 / 30 / 60+ min). Auto-texts the customer with an updated ETA and pings Matt.',
  },
  {
    title: 'Customer not home',
    body: "Texts the customer that you're at the door, escalates to Matt if no response after a few minutes.",
  },
  {
    title: 'Scope changed',
    body: "Free-text note + photos. Texts Matt so he can decide whether to update the estimate before you finish.",
  },
  {
    title: 'Something else',
    body: 'Free-text problem report direct to Matt.',
  },
];

export default async function IssuePage() {
  const session = await requireSession();
  const env = getEnv();

  return (
    <main className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-aac-blue/20 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Link
            href="/"
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-aac-blue/30 text-lg leading-none text-aac-blue active:bg-aac-blue/5"
          >
            ‹
          </Link>
          <h1 className="font-display text-lg font-bold tracking-tight text-aac-dark">
            Report an issue
          </h1>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Coming soon — for now, call or text Matt directly.
          </p>
          <div className="mt-3 flex gap-2">
            <a
              href={`tel:${env.notifications.alertPhoneNumber}`}
              className="flex-1 rounded-lg bg-aac-blue px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-white shadow-sm active:bg-aac-blue/85"
            >
              Call Matt
            </a>
            <a
              href={`sms:${env.notifications.alertPhoneNumber}`}
              className="flex-1 rounded-lg border border-aac-blue px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-aac-blue active:bg-aac-blue/5"
            >
              Text Matt
            </a>
          </div>
        </div>

        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            What this page will do
          </p>
          <ul className="mt-3 space-y-3">
            {PLANNED_CATEGORIES.map((c) => (
              <li
                key={c.title}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
              >
                <p className="font-display text-sm font-bold text-aac-dark">{c.title}</p>
                <p className="mt-1 text-sm text-zinc-600">{c.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-500">
          Signed in as {session.email}
        </p>
      </section>
    </main>
  );
}
