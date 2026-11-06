/**
 * D) REFERRAL / CAN'T HELP, MID-CONVERSATION (inbound router phase 4c,
 *    `inbound-router:live` includes referral). A customer Matt is already
 *    talking to asks for work on the can't-help list (new photos show a
 *    leaking block bulkhead, they add a driveway replacement). The router
 *    already judged it from its one read; this drafts a kind decline that
 *    continues the thread and names the referral, as a Quo note. Never sends.
 *
 * First-touch declines stay with intake (processRoutedIntake).
 */
import { REFERRAL_REPEAT_H, type DraftDeps, type DraftRecord } from './types.js';
import { draftReferralReply, gateReferral, referralFallback } from './voice.js';
import { postDraftNote } from './note.js';
import type { IntakeOutcome } from './intake.js';

/** What the inbound router hands the referral drafter. */
export interface RoutedReferral {
  reason: string;
  /** "Name (phone)" for each referral that fits, best first. */
  referrals: string[];
  /** The conversation, oldest first, as "CUSTOMER: ..." / "MATT: ..." lines. */
  conversation: string[];
  /** The read's description of this burst's photos. */
  photoNotes: string[];
}

export async function processRoutedReferral(deps: DraftDeps, phone: string, r: RoutedReferral): Promise<IntakeOutcome> {
  const now = deps.now?.() ?? Date.now();
  const last = await deps.state.getReferral(phone);
  if (last && now - new Date(last).getTime() < REFERRAL_REPEAT_H * 3600_000) {
    return { kind: 'skipped', reason: 'referral-drafted-recently' };
  }

  const reply = await draftReferralReply(deps.gemini, r);
  const gateFail = reply ? gateReferral(reply, r.referrals) : 'generation failed';
  const draft = gateFail ? referralFallback(r.referrals) : reply!;
  const kind = r.referrals.length ? 'REFERRAL' : "CAN'T HELP";
  const extra = `Why: ${r.reason}${r.referrals.length ? `\nReferral: ${r.referrals.join('; ')}` : ''}${gateFail ? `\n(fallback used: ${gateFail})` : ''}`;
  const record: DraftRecord = {
    type: 'referral', via: 'router', phone, outcome: 'drafted', fallback: gateFail ?? null, draft,
    reason: r.reason, referrals: r.referrals,
  };

  const posted = await postDraftNote(deps, phone, kind, draft, extra);
  // Mid-conversation, so the Quo contact exists; a miss is not worth retrying.
  if (!posted) return { kind: 'skipped', reason: 'no-quo-contact' };
  if (!deps.dryRun) {
    await deps.state.setReferral(phone, new Date(now).toISOString());
    await deps.state.appendRecord(record);
  }
  return { kind: 'drafted', record };
}
