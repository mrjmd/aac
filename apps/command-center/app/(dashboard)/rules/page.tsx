import { PROMOTION_RULES } from "@aac/items";
import { getItemStore } from "@/lib/items";
import { PageHeader } from "../components/layout-parts";
import { RulesView } from "./rules-view";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const store = getItemStore();
  const [promote, mutes] = await Promise.all([store.getPromotion(), store.getMutes()]);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Rules" sub="What moves things onto Today on its own, what you've muted, what you've dismissed" />
      <RulesView rules={PROMOTION_RULES} promote={promote} mutes={mutes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))} />
    </>
  );
}
