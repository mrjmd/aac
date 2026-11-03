import type { CashAccount } from "@aac/metrics";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../components/freshness";
import { NeedsAttention } from "../components/items";
import { PageHeader, SourceError, Tile, usd, usdK } from "../components/layout-parts";

export const dynamic = "force-dynamic";

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A register untouched for over a week means the feed queue needs review. */
const STALE_DAYS = 7;

export default async function MoneyPage() {
  const card = cards.cash();
  const { snap, error } = await loadSafe(card);
  const header = (
    <PageHeader
      eyebrow="Area"
      title="Money"
      sub={
        <>
          Cash, receivables, deposits, the books ·{" "}
          {snap && <Freshness name={card.name} fetchedAt={snap.fetchedAt} label="QuickBooks" />}
        </>
      }
    />
  );
  if (!snap) {
    return (
      <>
        {header}
        <SourceError what="QuickBooks" error={error} />
        <NeedsAttention areas={["money"]} />
      </>
    );
  }
  const p = snap.data;
  const relay = p.accounts.filter((a) => a.bank === "Relay");
  const other = p.accounts.filter((a) => a.bank !== "Relay");
  const behind = p.accounts.filter((a) => a.daysBehind === null || a.daysBehind > STALE_DAYS).length;

  return (
    <>
      {header}
      <NeedsAttention areas={["money"]} />
      <div className="tiles">
        <Tile
          k="Cash, all Relay accounts"
          v={usdK(p.relayTotal)}
          s={`${relay.length} accounts, per QuickBooks`}
          def="Sum of Relay registers as booked in QuickBooks. Not a live bank balance."
        />
        <Tile
          k="Receivables"
          v={usdK(p.ar.openTotal)}
          s={p.ar.overdueCount ? `${usdK(p.ar.overdueTotal)} overdue on ${p.ar.overdueCount}` : `${p.ar.openCount} open, none overdue`}
          tone={p.ar.overdueCount ? "bad" : "good"}
          def={`Open invoice balances. Source: QuickBooks. Date: due date.${p.ar.oldestDue ? ` Oldest overdue was due ${fmtDate(p.ar.oldestDue)}.` : ""}`}
        />
        <Tile
          k="Undeposited"
          v={usd(p.undeposited)}
          s={p.undeposited > 0 ? "Recorded, not yet in a bank" : "All deposited"}
          tone={p.undeposited > 0 ? "bad" : "good"}
          def="QuickBooks Undeposited Funds. A payment shows Paid before the money reaches the bank."
        />
        <Tile
          k="Books"
          v={behind ? `${behind} behind` : "Current"}
          s={behind ? `Registers over ${STALE_DAYS} days unposted` : `All registers posted within ${STALE_DAYS} days`}
          tone={behind ? "bad" : "good"}
          def="Newest posted transaction in each register. A register behind usually means feed items waiting for review."
        />
      </div>
      <div className="cols">
        <Accounts title="Relay accounts" accounts={relay} />
        {other.length > 0 && <Accounts title="Other banks" accounts={other} />}
      </div>
      <div className="note">
        These are QuickBooks register balances. A register matches the bank only once its feed queue is reviewed and
        reconciled, so a negative or odd balance usually means unposted feed items, not missing money. &ldquo;Posted
        through&rdquo; is the newest transaction in each register (searched back to {fmtDate(p.postingWindowStart)}).
      </div>
    </>
  );
}

function Accounts({ title, accounts }: { title: string; accounts: CashAccount[] }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Posted through</th>
              <th className="r">Balance</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const stale = a.daysBehind === null || a.daysBehind > STALE_DAYS;
              return (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "normal" }}>{a.name}</td>
                  <td style={stale ? { color: "var(--red)", fontWeight: 600 } : { color: "var(--muted)" }}>
                    {a.postedThrough ? `${fmtDate(a.postedThrough)} (${a.daysBehind}d)` : "None in window"}
                  </td>
                  <td className="r num" style={a.qboBalance < 0 ? { color: "var(--red)" } : undefined}>
                    {usd(a.qboBalance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
