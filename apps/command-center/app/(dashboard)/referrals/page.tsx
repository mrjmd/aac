import { easternDate } from "@aac/shared-utils/eastern";
import { getCanHelpStore, referralDrafts } from "@/lib/can-help";
import { ReferralsView } from "./referrals-view";

/** Who gets the work we don't do, and the standing rules the drafters read (Redis, no live fetch). */
export default async function ReferralsPage() {
  const store = getCanHelpStore();
  const [referrals, rules, drafts] = await Promise.all([store.referrals(), store.rules(), referralDrafts()]);
  return <ReferralsView initial={{ referrals, rules }} drafts={drafts} today={easternDate(new Date())} />;
}
