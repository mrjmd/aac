import Link from "next/link";
import { searchCustomers, type CustomerHit } from "@aac/customers";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../components/freshness";
import { PageHeader, SourceError } from "../components/layout-parts";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim();
  const index = cards.customerIndex();
  const { snap, error } = await loadSafe(index);
  const hits: CustomerHit[] = q && snap ? searchCustomers(snap.data, q) : [];

  return (
    <>
      <PageHeader
        eyebrow="Customers"
        title="Find a customer"
        sub={
          <>
            Search by name, phone, email or address ·{" "}
            <Freshness name={index.name} fetchedAt={snap?.fetchedAt} label={`${snap?.data.length ?? 0} QuickBooks customers`} />
          </>
        }
      />
      <form action="/customers">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="e.g. Fairweather, 617-555-0101, 39 Hobart"
          className="w-full rounded-[12px] border-2 border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-[14px] font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
        />
      </form>
      {error && <SourceError what="QuickBooks" error={error} />}
      {q && !error && hits.length === 0 && <div className="empty">No customer matches &ldquo;{q}&rdquo;.</div>}
      {hits.length > 0 && (
        <section className="sec">
          <div className="sec-h">
            <h2>Matches · {hits.length}</h2>
          </div>
          <div className="list">
            {hits.map((h) => (
              <Link key={h.id} href={`/customers/${h.id}`} className="item" style={{ textDecoration: "none", color: "var(--ink)" }}>
                <div className="row">
                  <div className="body">
                    <div className="title">{h.name}</div>
                    <div className="meta">
                      {h.company && <span className="tag">{h.company}</span>}
                      {h.phone && <span className="tag num">{h.phone}</span>}
                      {h.email && <span className="tag">{h.email}</span>}
                      {h.address && <span className="tag">{h.address}</span>}
                      {!h.active && <span className="tag red">Inactive</span>}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
