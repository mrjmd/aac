import { OverviewTabs, PageHeader } from "../components/layout-parts";

export default function MonthPage() {
  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="This month"
        sub="The trajectory toward May 2027"
        right={<OverviewTabs on="/month" />}
      />
      <div className="card">
        <h3>Not built yet</h3>
        <div>
          Rolling 3-month revenue, owner take-home, gross margin, owner hours, the revenue chart, tech #2 gates and Q4
          priorities go here. Revenue and margin wait on the 2026 books; owner hours waits on your two open decisions.
        </div>
      </div>
    </>
  );
}
