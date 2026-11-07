import { easternDate } from "@aac/shared-utils/eastern";
import { loadObligations } from "@/lib/obligations";
import { NeedsAttention } from "../components/items";
import { PageHeader } from "../components/layout-parts";
import { ImportantDates } from "./important-dates";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const obligations = await loadObligations();
  return (
    <>
      <PageHeader eyebrow="Area" title="Admin" sub="Deadlines, insurance, COIs, documents" />
      <NeedsAttention areas={["admin"]} />
      <ImportantDates initial={obligations} today={easternDate(new Date())} />
      <div className="card">
        <h3>Not built yet</h3>
        <div>COI requests and the documents vault (policies, certificates, licenses, filing receipts) go here.</div>
      </div>
    </>
  );
}
