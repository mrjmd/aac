export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm text-zinc-500">Pulling QuickBooks, texts, calls, email and the calendar…</p>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[74px] animate-pulse rounded-xl border border-zinc-200 bg-white" />
        ))}
      </div>
      <div className="mt-6 h-96 animate-pulse rounded-xl border border-zinc-200 bg-white" />
    </div>
  );
}
