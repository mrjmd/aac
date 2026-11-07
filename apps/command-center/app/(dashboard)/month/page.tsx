import {
  BOOKED_WEEKS_GATE,
  buildMonthlyRevenue,
  buildTech2Gates,
  CHARTER_FLOOR,
  CHARTER_TARGET,
  WINTER_MULTIPLIER,
  type RevenueMonth,
  type Scorecard,
} from "@aac/metrics";
import { easternDate } from "@aac/shared-utils/eastern";
import { keys } from "@aac/shared-utils/redis";
import { cards, loadSafe } from "@/lib/cards";
import { getRedis } from "@/lib/redis";
import { Freshness } from "../components/freshness";
import { OverviewTabs, PageHeader, SourceError, Tile, usdK } from "../components/layout-parts";
import { RevenueChart } from "./revenue-chart";

export const dynamic = "force-dynamic";

const monthName = (m: string, o: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });

function Gate({ label, value, pct, st }: { label: string; value: string; pct?: number; st?: { tone: "on" | "risk" | "off" | "nd"; text: string } }) {
  return (
    <>
      <div className="gate">
        <span>{label}</span>
        {st ? <span className={`st ${st.tone}`}>{st.text}</span> : <span className="num">{value}</span>}
      </div>
      {pct != null && (
        <div className="bar">
          <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      )}
      {st && value && <div className="note" style={{ padding: "0 0 4px", background: "transparent" }}>{value}</div>}
    </>
  );
}

/** The trajectory toward May 2027: revenue against the charter, and the tech #2 gates (approved mockup's This month). */
export default async function MonthPage() {
  const today = easternDate(new Date());
  const invCard = cards.monthInvoices();
  const [inv, cash, score] = await Promise.all([
    loadSafe(invCard),
    loadSafe(cards.cash()),
    getRedis()
      .get<Scorecard>(keys.scorecard)
      .catch(() => null),
  ]);
  const lastClosed = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 15)).toISOString().slice(0, 7);
  const header = (
    <PageHeader
      eyebrow="Overview"
      title="This month"
      sub={
        <>
          {monthName(lastClosed)} closed · the trajectory toward May 2027 ·{" "}
          {inv.snap && <Freshness name={invCard.name} fetchedAt={inv.snap.fetchedAt} label="QuickBooks" />}
        </>
      }
      right={<OverviewTabs on="/month" />}
    />
  );
  if (!inv.snap) {
    return (
      <>
        {header}
        <SourceError what="QuickBooks invoices" error={inv.error} />
      </>
    );
  }

  const rev = buildMonthlyRevenue(inv.snap.data, today);
  const bookedRow = score?.rows.find((r) => r.key === "booked");
  const gates = buildTech2Gates({
    invoices: inv.snap.data,
    cash: cash.snap?.data ?? null,
    // Closed weeks only: the open week's value is as of this Monday too, but it isn't judged yet.
    bookedWeeks: bookedRow ? bookedRow.values.slice(0, -1) : [],
    today,
  });
  const cur = rev.months[rev.months.length - 1] as RevenueMonth;
  const r3 = rev.rolling3;
  const w = gates.winter;
  const winterLabel = `${monthName(w.months[0]!, { month: "short", year: "numeric" })} to ${monthName(w.months[3]!, { month: "short", year: "numeric" })}`;

  return (
    <>
      {header}
      <div className="tiles">
        <Tile
          k="Rolling 3-month revenue"
          v={r3 == null ? "n/a" : `${usdK(r3)} / mo`}
          s={r3 == null ? "" : r3 >= CHARTER_FLOOR ? `${usdK(r3 - CHARTER_FLOOR)} over the $${CHARTER_FLOOR / 1000}k floor` : `${usdK(CHARTER_FLOOR - r3)} under the $${CHARTER_FLOOR / 1000}k floor`}
          tone={r3 == null ? undefined : r3 >= CHARTER_FLOOR ? "good" : "bad"}
          def="Average monthly revenue over the last 3 closed months. Revenue = QuickBooks invoice totals by invoice date. This is what the charter measures in Mar-May 2027: $50k floor, $80k target."
        />
        <Tile
          k="Last 12 months"
          v={usdK(rev.ttm)}
          s={rev.ttmLastYear ? `${rev.ttm >= rev.ttmLastYear ? "+" : ""}${Math.round((100 * (rev.ttm - rev.ttmLastYear)) / rev.ttmLastYear)}% vs the 12 before` : "Invoice totals, closed months"}
          tone={rev.ttmLastYear ? (rev.ttm >= rev.ttmLastYear ? "good" : "bad") : undefined}
          def="Invoice totals over the last 12 closed months, against the 12 months before that."
        />
        <Tile
          k={`${monthName(cur.month, { month: "long" })} so far`}
          v={usdK(cur.revenue)}
          s={cur.lastYear != null ? `${usdK(cur.lastYear)} all of ${monthName(cur.month, { month: "short" })} last year` : ""}
          def="Invoices dated this month so far, beside the whole same month last year."
        />
        <Tile
          k="Take-home, margin, owner hours"
          v="Not built"
          s="Take-home and margin wait on the 2026 books; hours on your two open decisions"
          def="The mockup's other three tiles. Owner take-home and gross margin come from the reconciled P&L; owner hours needs a source decision."
        />
      </div>

      <div className="card">
        <h3>Revenue by month, rolling 3-month average</h3>
        <RevenueChart months={rev.months} floor={CHARTER_FLOOR} target={CHARTER_TARGET} />
        <div className="note">
          Bars are monthly revenue (QuickBooks invoices by invoice date); the faint bar behind each is the same month a year earlier. The line is the
          rolling 3-month average the charter judges in March to May 2027. {monthName(cur.month, { month: "long" })} is still open and isn&apos;t in the
          average.
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <h3>Tech #2 gates (hire Mar 1)</h3>
          {cash.error && !cash.snap && <SourceError what="QuickBooks accounts" error={cash.error} />}
          <Gate
            label={`Set aside $60-70k (reserve + hire fund)`}
            value={usdK(gates.vaults.balance)}
            pct={(100 * gates.vaults.balance) / gates.vaults.target[0]}
          />
          <div className="note" style={{ padding: "0 0 4px", background: "transparent" }}>
            Reserve (Payroll + Opex) {usdK(gates.reserve.balance)} of {usdK(gates.reserve.target[0])}-{usdK(gates.reserve.target[1])}, due Nov 1. Hire fund
            (New Technician) {usdK(gates.hireFund.balance)} of {usdK(gates.hireFund.target[0])}-{usdK(gates.hireFund.target[1])}, due Jan 31. QuickBooks
            register balances.
          </div>
          <Gate
            label={`Winter ${WINTER_MULTIPLIER}x (${winterLabel})`}
            value={
              w.monthsIn
                ? `${usdK(w.thisWinter)} so far of ${usdK(w.needed)} needed (last winter ${usdK(w.lastWinter)} × ${WINTER_MULTIPLIER}).${w.multiplierSoFar != null ? ` Closed months are ${w.multiplierSoFar}x the same months last winter.` : ""}`
                : `Needs ${usdK(w.needed)} (last winter ${usdK(w.lastWinter)} × ${WINTER_MULTIPLIER}).`
            }
            st={
              !w.monthsIn
                ? { tone: "nd", text: "Starts Nov" }
                : w.multiplierSoFar == null
                  ? { tone: "nd", text: `${monthName(w.months[0]!, { month: "short" })} in progress` }
                  : { tone: w.multiplierSoFar >= WINTER_MULTIPLIER ? "on" : "off", text: `${w.multiplierSoFar}x` }
            }
          />
          <Gate
            label={`Booked ${BOOKED_WEEKS_GATE}+ weeks out, persistently`}
            value={
              gates.booked.weeksSeen
                ? `${gates.booked.weeksAtGate} of the last ${gates.booked.weeksSeen} weeks at ${BOOKED_WEEKS_GATE}+ (scorecard, Monday mornings).`
                : "Waiting on the nightly scorecard."
            }
            st={
              gates.booked.latest == null
                ? { tone: "nd", text: "No data" }
                : { tone: gates.booked.latest >= BOOKED_WEEKS_GATE ? "on" : "off", text: `${gates.booked.latest.toFixed(1)} wks` }
            }
          />
          <div className="note">
            From the tech #2 plan: Dec 31 checkpoint (reserve banked, Nov-Dec on pace, lead time held), Jan 31 go/no-go. The large-quote gate ($5k+ quotes
            lost on timeline) isn&apos;t tracked yet.
          </div>
        </div>
      </div>
    </>
  );
}
