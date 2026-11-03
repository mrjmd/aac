import { NeedsAttention } from "../components/items";
import { PageHeader } from "../components/layout-parts";

export default function AdminPage() {
  return (
    <>
      <PageHeader eyebrow="Area" title="Admin" sub="Deadlines, insurance, COIs, documents" />
      <NeedsAttention areas={["admin"]} />
      <div className="card">
        <h3>Not built yet</h3>
        <div>
          The obligations calendar, COI requests and the documents vault go here. They need the admin facts (formation
          date, policy dates, license dates) and a storage pick for the vault.
        </div>
      </div>
    </>
  );
}
