export default function CommercialPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Commercial</h1>
        <p className="mt-1 text-xs text-zinc-400">Placeholder. A future bet with its own gates.</p>
      </header>
      <div className="rounded-xl border border-zinc-200 bg-white p-5 text-sm leading-relaxed text-zinc-600">
        <p>
          Public jobs under $50k, housing-authority and school repairs, municipal on-call contracts, and GC subcontracts.
          The weekly bid list lands here once the crawl (free registrations and alert emails) is running.
        </p>
        <p className="mt-3 font-semibold text-aac-dark">Read first</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>docs/plans/command-center/README.md §7 (crawl, walk, run and the gates)</li>
          <li>docs/plans/command-center/research-commercial-bids.md (sources, rules, which platforms allow automation)</li>
        </ul>
        <p className="mt-3 text-xs text-zinc-400">
          Gates before bidding: prevailing wage and certified payroll on every public job, payment bonds over $25k
          (bonding needs CPA-reviewed financials), and capacity until tech #2.
        </p>
      </div>
    </div>
  );
}
