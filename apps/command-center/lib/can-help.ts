import { CanHelpStore } from "@aac/quoting";
import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

export function getCanHelpStore(): CanHelpStore {
  return new CanHelpStore(getRedis());
}

/** A decline or referral note the drafters posted (message-drafts runlog). */
export interface ReferralDraft {
  at: string;
  phone: string;
  /** first = intake's first reply; later = the router's mid-conversation note. */
  when: "first" | "later";
  /** null = an older record that didn't store them. */
  referrals: string[] | null;
  reason: string | null;
  draft: string;
}

/** Newest decline and referral notes from the drafts runlog (last 500 records of every kind). */
export async function referralDrafts(limit = 20): Promise<ReferralDraft[]> {
  const raw = await getRedis().lrange<unknown>(keys.messageDraftRunlog, 0, 499);
  const out: ReferralDraft[] = [];
  for (const item of raw) {
    let r: Record<string, unknown>;
    try {
      r = (typeof item === "string" ? JSON.parse(item) : item) as Record<string, unknown>;
    } catch {
      continue;
    }
    const later = r.type === "referral";
    if (r.outcome !== "drafted" || !(later || (r.type === "intake" && r.verdict === "cant-help"))) continue;
    out.push({
      at: String(r.at ?? ""),
      phone: String(r.phone ?? ""),
      when: later ? "later" : "first",
      referrals: Array.isArray(r.referrals) ? r.referrals.map(String) : null,
      reason: typeof r.reason === "string" ? r.reason : null,
      draft: String(r.draft ?? ""),
    });
    if (out.length >= limit) break;
  }
  return out;
}
