export const dynamic = 'force-dynamic';

interface SearchParams {
  next?: string;
  error?: string;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const signInHref = `/auth/google?next=${encodeURIComponent(safeNext)}`;

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-md flex-col items-center justify-center px-6 py-12">
      <div className="w-full rounded-2xl border border-aac-blue/20 bg-white p-7 shadow-[6px_6px_0px_0px_rgba(30,111,184,0.12)]">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.webp"
            alt="Attack A Crack"
            className="h-14 w-14 rounded-xl object-cover shadow-[4px_4px_0px_0px_rgba(30,111,184,0.2)]"
          />
          <div className="flex flex-col leading-none">
            <span className="font-display text-xl font-black tracking-tight text-aac-dark">
              ATTACK A CRACK
            </span>
            <span className="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-aac-blue">
              Field App
            </span>
          </div>
        </div>

        <p className="mt-6 text-sm text-aac-dark/70">
          Sign in with your AAC Google account to see today&apos;s jobs.
        </p>

        {error ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <a
          href={signInHref}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-lg border border-aac-blue/30 bg-white px-4 py-3 text-base font-semibold text-aac-dark shadow-sm transition hover:bg-aac-blue/5 active:bg-aac-blue/10"
        >
          <GoogleG className="h-5 w-5" />
          <span>Sign in with Google</span>
        </a>

        <p className="mt-6 text-xs text-aac-dark/50">
          Only AAC staff are authorized. If you got here by mistake, you can close this tab.
        </p>
      </div>
    </main>
  );
}

function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}
