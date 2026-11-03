const OFF_CARDS = [
  {
    title: "Lead sources",
    what: "New leads and customers by where they came from (Google Ads, LSA, organic, GBP, Ed and realtors, referrals, repeat).",
  },
  {
    title: "CAC by channel",
    what: "Spend per channel divided by customers won from it, trailing 3 months, with the trend. Ed shows as his own channel row for the spring decision.",
  },
  {
    title: "Source → customer flow",
    what: "How leads from each source move through quote, booked and paid, and where each one drops.",
  },
];

export default function MarketingPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Marketing</h1>
      </header>

      <div className="mb-6 rounded-2xl border-2 border-amber-300 bg-amber-50 p-5">
        <p className="font-display text-lg font-bold text-amber-900">You&apos;ve got to figure this out first.</p>
        <p className="mt-2 text-sm leading-relaxed text-amber-900">
          Lead source isn&apos;t captured when a lead comes in. It&apos;s blank on 1,209 of 1,601 contacts created in
          2026, so every number below would be a guess. These views are built but switched off until source capture
          is fixed. Retrofitting old leads is unlikely; the fix is forward-looking.
        </p>
        <p className="mt-3 text-sm font-semibold text-amber-900">What unlocks it</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-900">
          <li>Website-to-call matching (GA4 click to Quo call; validated at 57% with no false matches).</li>
          <li>Google Ads lead disposition (Stream A), so ad leads are marked won or lost.</li>
          <li>A source asked and recorded at intake for everything else (referrals, GBP, Ed).</li>
          <li>Spend categorized by channel in the books (depends on the 2026 books cleanup).</li>
        </ul>
        <p className="mt-3 text-xs text-amber-800">
          Plan: docs/plans/command-center/README.md §5 and §14.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {OFF_CARDS.map((c) => (
          <div key={c.title} className="rounded-xl border border-dashed border-zinc-300 bg-white p-4 opacity-70">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-aac-dark">{c.title}</p>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-500">Off</span>
            </div>
            <p className="mt-2 text-xs text-zinc-500">{c.what}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
