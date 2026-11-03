import { PageHeader } from "../components/layout-parts";

export default function CommercialPage() {
  return (
    <>
      <PageHeader eyebrow="Area" title="Commercial" sub="Later: spring 2027. Shown here so the shape is clear." />
      <div className="callout">
        Weekly, an agent reads COMMBUYS alerts, the MA Central Register and GC invite emails, then ranks bids by fit,
        distance and what they require. You decide what to chase. Not running yet.
      </div>
      <div className="card">
        <h3>What lands here</h3>
        <div>
          Public jobs under $50k, housing-authority and school repairs, municipal on-call contracts, and GC
          subcontracts. The weekly bid list appears once the crawl (free registrations and alert emails) is running.
        </div>
        <div className="note">
          Gates before bidding: prevailing wage and certified payroll on every public job, payment bonds over $25k
          (bonding needs CPA-reviewed financials), and capacity until tech #2. Read first:
          docs/plans/command-center/README.md §7 and research-commercial-bids.md.
        </div>
      </div>
    </>
  );
}
