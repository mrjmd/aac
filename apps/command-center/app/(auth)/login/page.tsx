export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const href = `/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8">
        <h1 className="font-display mb-1 text-xl font-bold text-aac-dark">
          AAC Command Center
        </h1>
        <p className="mb-6 text-sm text-zinc-400">
          Sign in with your Attack A Crack Google account.
        </p>

        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

        <a
          href={href}
          className="block w-full rounded-lg bg-aac-blue px-4 py-2.5 text-center text-sm font-bold text-white transition-colors hover:bg-aac-blue/90"
        >
          Sign in with Google
        </a>
        {process.env.NODE_ENV === "development" && (
          <a
            href={`/auth/dev${next ? `?next=${encodeURIComponent(next)}` : ""}`}
            className="mt-3 block text-center text-xs text-zinc-400 hover:text-aac-blue"
          >
            Local sign-in (this Mac only)
          </a>
        )}
      </div>
    </div>
  );
}
