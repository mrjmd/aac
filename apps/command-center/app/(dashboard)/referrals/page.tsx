import { easternDate } from "@aac/shared-utils/eastern";
import { getCanHelpStore } from "@/lib/can-help";
import { ReferralsView } from "./referrals-view";

/** Who gets the work we don't do, and the standing rules the drafters read (Redis, no live fetch). */
export default async function ReferralsPage() {
  const store = getCanHelpStore();
  const [referrals, rules] = await Promise.all([store.referrals(), store.rules()]);
  return <ReferralsView initial={{ referrals, rules }} today={easternDate(new Date())} />;
}
