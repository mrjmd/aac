import Link from "next/link";
import { searchCustomers, type CustomerHit } from "@aac/customers";
import { cn } from "@aac/ui";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../components/freshness";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim();
  const index = cards.customerIndex();
  const { snap, error } = await loadSafe(index);
  const hits: CustomerHit[] = q && snap ? searchCustomers(snap.data, q) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Customers</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
          Search by name, phone, email or address.
          <Freshness name={index.name} fetchedAt={snap?.fetchedAt} label={`${snap?.data.length ?? 0} QuickBooks customers`} />
        </p>
      </header>

      <form action="/customers" className="mb-5">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="e.g. Fairweather, 617-555-0101, 39 Hobart"
          className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-aac-dark outline-none focus:border-aac-blue"
        />
      </form>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Couldn&apos;t reach QuickBooks: {error}
        </p>
      )}
      {q && !error && hits.length === 0 && <p className="text-sm text-zinc-500">No customer matches &ldquo;{q}&rdquo;.</p>}
      {hits.length > 0 && (
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
          {hits.map((h) => (
            <Link key={h.id} href={`/customers/${h.id}`} className="block px-4 py-3 hover:bg-zinc-50">
              <p className={cn("text-sm font-semibold", h.active ? "text-aac-dark" : "text-zinc-400")}>
                {h.name}
                {h.company && <span className="ml-2 font-normal text-zinc-500">{h.company}</span>}
                {!h.active && <span className="ml-2 text-xs font-normal">inactive</span>}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {[h.phone, h.email, h.address].filter(Boolean).join(" · ") || "No contact details in QuickBooks"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
