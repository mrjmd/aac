import { NeedsAttention } from "../components/items";
import { PageHeader } from "../components/layout-parts";

export default function SalesPage() {
  return (
    <>
      <PageHeader eyebrow="Area" title="Sales" sub="Leads to assessments to quotes to won" />
      <NeedsAttention areas={["sales", "inbox"]} />
      <div className="card">
        <h3>Not built yet</h3>
        <div>
          Open quotes, close rate, missed demand, the funnel and lead sources go here. Lead source is blank on most 2026
          contacts, so the funnel and source tables wait on source capture (see Marketing).
        </div>
      </div>
    </>
  );
}
