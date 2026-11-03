import type { CashAccount } from "@aac/metrics";
import { cn } from "@aac/ui";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../components/freshness";

export const dynamic = "force-dynamic";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A register untouched for over a week means the feed queue needs review. */
const STALE_DAYS = 7;

export default async function MoneyPage() {
  const card = cards.cash();
  const { snap, error } = await loadSafe(card);
  if (!snap) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Money</h1>
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Couldn&apos;t reach QuickBooks: {error}
        </p>
      </div>
    );
  }
  const position = snap.data;
  const relay = position.accounts.filter((a) => a.bank === "Relay");
  const other = position.accounts.filter((a) => a.bank !== "Relay");

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Money</h1>
        <Freshness name={card.name} fetchedAt={snap.fetchedAt} label="From QuickBooks," className="mt-1" />
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Relay, per QuickBooks" value={money(position.relayTotal)} note={`${relay.length} accounts`} />
        <Stat
          label="Undeposited"
          value={money(position.undeposited)}
          note="Recorded payments not yet in a bank"
          warn={position.undeposited > 0}
        />
        <Stat
          label="Owed to us"
          value={money(position.ar.openTotal)}
          note={
            position.ar.overdueCount
              ? `${money(position.ar.overdueTotal)} overdue on ${position.ar.overdueCount} invoices${
                  position.ar.oldestDue ? `, oldest due ${fmtDate(position.ar.oldestDue)}` : ""
                }`
              : `${position.ar.openCount} open invoices, none overdue`
          }
          warn={position.ar.overdueCount > 0}
        />
      </div>

      <AccountTable title="Relay" accounts={relay} />
      {other.length > 0 && <AccountTable title="Other banks" accounts={other} />}

      <p className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 text-xs leading-relaxed text-zinc-500">
        These are QuickBooks register balances. A register matches the bank only once its feed queue is
        reviewed and reconciled, so a negative or odd balance usually means unposted feed items, not missing
        money. &ldquo;Posted through&rdquo; is the newest transaction in each register (searched back to{" "}
        {fmtDate(position.postingWindowStart)}); anything over {STALE_DAYS} days behind is flagged.
      </p>
    </div>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="font-display mt-1 text-2xl font-bold text-aac-dark">{value}</p>
      <p className={cn("mt-1 text-xs", warn ? "font-medium text-amber-700" : "text-zinc-400")}>{note}</p>
    </div>
  );
}

function AccountTable({ title, accounts }: { title: string; accounts: CashAccount[] }) {
  return (
    <section className="mb-4">
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">{title}</h2>
      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
        {accounts.map((a) => {
          const stale = a.daysBehind === null || a.daysBehind > STALE_DAYS;
          return (
            <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-aac-dark">{a.name}</p>
                <p className={cn("text-xs", stale ? "font-medium text-amber-700" : "text-zinc-400")}>
                  {a.postedThrough
                    ? `Posted through ${fmtDate(a.postedThrough)} (${a.daysBehind}d ago)`
                    : "Nothing posted in the window"}
                </p>
              </div>
              <p className={cn("shrink-0 text-sm font-semibold tabular-nums", a.qboBalance < 0 ? "text-red-600" : "text-aac-dark")}>
                {money(a.qboBalance)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
