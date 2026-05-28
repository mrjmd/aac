import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { getUserConfig } from '@/lib/user-config';
import { DEFAULT_HOME_ADDRESS } from '@/lib/travel-time';
import SettingsForm from './settings-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ saved?: string }>;
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const session = await requireSession();
  const config = await getUserConfig(session.email);

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
            Settings
          </h1>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-4 py-6">
        {params.saved === '1' && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Saved.
          </div>
        )}

        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="mb-3">
            <h2 className="font-display text-base font-bold text-aac-dark">Account</h2>
            <p className="mt-0.5 text-xs text-zinc-500">{session.email}</p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="mb-3">
            <h2 className="font-display text-base font-bold text-aac-dark">Home base</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Used to estimate the drive time from your house to the first job and back
              home after the last.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Default if blank:{' '}
              <span className="font-medium text-zinc-700">{DEFAULT_HOME_ADDRESS}</span>
            </p>
          </div>

          <SettingsForm initialHomeAddress={config.homeAddress ?? ''} />
        </div>

        <form action="/auth/signout" method="post" className="mt-6">
          <button
            type="submit"
            className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-sm font-medium text-aac-dark active:bg-zinc-100"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
