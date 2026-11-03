import { NeedsAttention } from "../components/items";
import { PageHeader } from "../components/layout-parts";

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
    <>
      <PageHeader eyebrow="Area" title="Marketing" sub="Spend, customers by channel, cost to acquire a customer" />
      <div className="callout">
        <b>You&apos;ve got to figure this out first.</b> Lead source isn&apos;t captured when a lead comes in. It&apos;s
        blank on 1,209 of 1,601 contacts created in 2026, so every number here would be a guess. These views are built
        but switched off until source capture is fixed. Retrofitting old leads is unlikely; the fix is forward-looking.
      </div>
      <div className="card">
        <h3>What unlocks it</h3>
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>Website-to-call matching (GA4 click to Quo call; validated at 57% with no false matches).</li>
          <li>Google Ads lead disposition (Stream A), so ad leads are marked won or lost.</li>
          <li>A source asked and recorded at intake for everything else (referrals, GBP, Ed).</li>
          <li>Spend categorized by channel in the books (depends on the 2026 books cleanup).</li>
        </ul>
        <div className="note">Plan: docs/plans/command-center/README.md §5 and §14.</div>
      </div>
      <NeedsAttention areas={["marketing"]} />
      <div className="tiles">
        {OFF_CARDS.map((c) => (
          <div key={c.title} className="tile" style={{ borderStyle: "dashed", opacity: 0.75 }}>
            <div className="k">
              <span>{c.title}</span>
              <span className="st nd">Off</span>
            </div>
            <div className="s">{c.what}</div>
          </div>
        ))}
      </div>
    </>
  );
}
