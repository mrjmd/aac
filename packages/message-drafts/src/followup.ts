/**
 * A) POST-QUOTE FOLLOW-UP — a QBO estimate was emailed (EmailStatus=
 * EmailSent; EmailStatus is not SQL-queryable so the sweep filters
 * client-side). If Matt hasn't already texted the customer since the
 * email went out, draft the "just sent that quote over" text and post it
 * as a contact note.
 *
 * Entry points:
 *  - processFollowupEstimate: one estimate (worker fast lane / queue drain)
 *  - sweepFollowups: 36h QBO lookback (backstop)
 */
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import {
  AUTO_RE,
  FOLLOWUP_LOOKBACK_H,
  INTERNAL,
  type DraftDeps,
  type DraftRecord,
} from './types.js';
import { draftFollowup, followupFallback, gateFollowup, pickExemplars } from './voice.js';
import { FOLLOWUP_EXEMPLARS } from './data/exemplars.js';
import { postDraftNote } from './note.js';
import { isDone } from './state.js';

function scopeLinesOf(est: QBEstimate): string[] {
  return est.Line.filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
    .map((l) => `- ${l.SalesItemLineDetail!.ItemRef!.name}${l.Description ? `: ${l.Description.slice(0, 180)}` : ''}`);
}

/** Candidate test shared by the fast lane and the sweep. */
export function isFollowupCandidate(est: QBEstimate): boolean {
  return est.EmailStatus === 'EmailSent' && est.TxnStatus === 'Pending';
}

/**
 * Draft + post the follow-up for one estimate. Claims the estimate first
 * so concurrent actors (fast lane, tick, sweep, laptop) never double-post.
 */
export async function processFollowupEstimate(
  deps: DraftDeps,
  est: QBEstimate,
  opts: { firstRun?: boolean } = {},
): Promise<DraftRecord | null> {
  const now = deps.now?.() ?? Date.now();
  const { qb, quo, gemini, state, dryRun } = deps;
  const seed = Math.floor(now / 600_000); // rotates exemplar window per cycle

  if (!isFollowupCandidate(est)) return null;
  if (isDone(await state.getFollowup(est.Id), now)) return null;
  if (!dryRun && !(await state.claimFollowup(est.Id))) return null;

  const finish = async (marker: string, record: DraftRecord | null): Promise<DraftRecord | null> => {
    if (!dryRun) await state.setFollowup(est.Id, marker);
    if (record && !dryRun) await state.appendRecord(record);
    return record;
  };

  // first activation: only pick up emails from the last 12h (no stale follow-ups)
  if (opts.firstRun) {
    const at = est.DeliveryInfo?.DeliveryTime ?? est.MetaData?.LastUpdatedTime;
    if (!at || now - new Date(at).getTime() >= 12 * 3_600_000) {
      return finish('skipped:stale-at-first-run', null);
    }
  }

  const customer = await qb.getCustomer(est.CustomerRef.value);
  const phone = quickNormalizePhone(customer?.PrimaryPhone?.FreeFormNumber ?? null);
  if (!phone || INTERNAL.has(phone)) {
    return finish('skipped:no-phone', { type: 'followup', estimateId: est.Id, doc: est.DocNumber, outcome: 'no-phone' });
  }

  // if Matt already texted them since the email went out, he's got it
  const emailedAt = new Date(est.DeliveryInfo?.DeliveryTime ?? est.MetaData?.LastUpdatedTime ?? now).getTime();
  const recent = await quo.listMessages({ participantE164: phone, maxResults: 20 });
  const mattAlready = (recent.data ?? []).some(
    (m) => m.direction === 'outgoing' && !AUTO_RE.test(m.text ?? '') && new Date(m.createdAt).getTime() > emailedAt,
  );
  if (mattAlready) {
    return finish('skipped:matt-already-texted', { type: 'followup', estimateId: est.Id, doc: est.DocNumber, outcome: 'matt-already-texted' });
  }

  const firstName = customer?.GivenName ?? customer?.DisplayName?.split(' ')[0] ?? null;
  let draft = await draftFollowup(gemini, {
    firstName,
    scopeLines: scopeLinesOf(est),
    exemplars: pickExemplars(FOLLOWUP_EXEMPLARS, 6, seed),
  });
  const gateFail = draft ? gateFollowup(draft) : 'generation failed';
  if (gateFail) {
    const summary = est.Line.filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
      .map((l) => l.SalesItemLineDetail!.ItemRef!.name!.toLowerCase()).join(' + ') || 'the repair work we discussed';
    draft = followupFallback(firstName, summary);
  }

  const posted = await postDraftNote(deps, phone, 'POST-QUOTE FOLLOW-UP', draft!,
    `Quote #${est.DocNumber ?? est.Id} emailed ${new Date(emailedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}.${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`);
  if (!posted) {
    // no Quo contact yet — release the claim so a later pass retries
    if (!dryRun) {
      await state.releaseFollowup(est.Id);
      await state.appendRecord({ type: 'followup', estimateId: est.Id, doc: est.DocNumber, phone, outcome: 'no-quo-contact' });
    }
    return { type: 'followup', estimateId: est.Id, doc: est.DocNumber, phone, outcome: 'no-quo-contact' };
  }
  return finish(new Date(now).toISOString(), {
    type: 'followup', estimateId: est.Id, doc: est.DocNumber, phone, outcome: 'drafted', fallback: gateFail ?? null, draft,
  });
}

/** Fetch one estimate by ID and process it (fast lane / queue drain). */
export async function processFollowupById(deps: DraftDeps, estimateId: string): Promise<DraftRecord | null> {
  const now = deps.now?.() ?? Date.now();
  if (isDone(await deps.state.getFollowup(estimateId), now)) return null;
  const est = await deps.qb.getEstimate(estimateId).catch(() => null);
  if (!est) return null;
  return processFollowupEstimate(deps, est);
}

/** 36h QBO lookback — the backstop that catches anything the events missed. */
export async function sweepFollowups(
  deps: DraftDeps,
  opts: { maxDrafts?: number; firstRun?: boolean } = {},
): Promise<DraftRecord[]> {
  const now = deps.now?.() ?? Date.now();
  const sinceIso = new Date(now - FOLLOWUP_LOOKBACK_H * 3_600_000).toISOString();
  const res = await deps.qb.query<{ QueryResponse: { Estimate?: QBEstimate[] } }>(
    `SELECT * FROM Estimate WHERE MetaData.LastUpdatedTime > '${sinceIso}' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 100`,
  );
  const records: DraftRecord[] = [];
  let drafted = 0;
  for (const est of res.QueryResponse.Estimate ?? []) {
    if (drafted >= (opts.maxDrafts ?? Infinity)) break;
    const record = await processFollowupEstimate(deps, est, { firstRun: opts.firstRun });
    if (record) {
      records.push(record);
      if (record.outcome === 'drafted') drafted++;
    }
  }
  return records;
}
