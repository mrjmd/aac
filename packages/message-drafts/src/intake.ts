/**
 * B) FIRST-TOUCH INTAKE ASK — a 1:1 thread with no manual reply whose
 *    first inbound (text or voicemail) is ≥10 min old (Matt's preemption
 *    window, owner-set 2026-10-19) and <48h old, classified as a real
 *    lead (not solicitation). Aged by the inquiry, never
 *    conversation.createdAt.
 *
 * C) CT→LUC ROUTING — same trigger as (B), but the classifier determined
 *    the PROPERTY is in Connecticut (content-based; area code is only a
 *    hint). One note carries BOTH drafts: the handoff text for Matt to
 *    send Luc and the customer "you've reached the MA office" reply.
 *
 * Entry points:
 *  - processIntakePhone: one thread (worker tick draining the due ZSET)
 *  - sweepIntake: 6h conversation poll (backstop)
 */
import {
  AUTO_RE,
  CT_AREA_CODES,
  INTAKE_REPLY_WINDOW_MIN,
  INTAKE_THREAD_MAX_AGE_H,
  INTERNAL,
  MAX_NOTE_ATTEMPTS,
  REAL_LEAD_RE,
  SPAM_RE,
  type DraftDeps,
  type DraftRecord,
} from './types.js';
import {
  buildLucHandoff,
  ctRoutingFallback,
  draftCtRouting,
  draftIntake,
  gateCtRouting,
  gateIntake,
  intakeFallback,
  pickExemplars,
} from './voice.js';
import { CT_ROUTING_EXEMPLARS, INTAKE_EXEMPLARS } from './data/exemplars.js';
import { postDraftNote } from './note.js';
import { isDone } from './state.js';

export type IntakeOutcome =
  | { kind: 'drafted'; record: DraftRecord }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry-later'; reason: string };

/**
 * Run the full intake decision tree for one phone. All guards live here;
 * callers (fast lane and sweep) may invoke it on anything — it re-validates.
 */
export async function processIntakePhone(deps: DraftDeps, phone: string): Promise<IntakeOutcome> {
  const now = deps.now?.() ?? Date.now();
  const { quo, gemini, state, dryRun } = deps;
  const seed = Math.floor(now / 600_000);

  if (!phone.startsWith('+') || INTERNAL.has(phone)) return { kind: 'skipped', reason: 'not-a-customer-line' };
  if (isDone(await state.getIntake(phone), now)) return { kind: 'skipped', reason: 'already-done' };

  const skip = async (reason: string): Promise<IntakeOutcome> => {
    if (!dryRun) {
      await state.setIntake(phone, `skipped:${reason}`);
      await state.appendRecord({ type: 'intake', phone, outcome: reason });
    }
    return { kind: 'skipped', reason };
  };

  const msgs = (await quo.listMessages({ participantE164: phone, maxResults: 50 })).data ?? [];
  const inbound = msgs.filter((m) => m.direction === 'incoming');
  const manualOut = msgs.filter((m) => m.direction === 'outgoing' && !AUTO_RE.test(m.text ?? ''));
  if (manualOut.length > 0) return skip('matt-replied');

  // Voice-call engagement guard (Kevin Maldarelli miss, 2026-10-20: an
  // existing commercial customer texted 19 callback photos from a number
  // with zero prior texts, and the intake pass pitched him the new-lead
  // ask). Not a first touch when:
  //   (a) Matt DIALED them and connected — the voice equivalent of the
  //       matt-replied text guard above; or
  //   (b) a completed call predates the inquiry window by ≥48h — they
  //       spoke with Matt in some earlier episode.
  // An INBOUND completed call minutes before the photos stays eligible —
  // that's the normal call-then-text first touch (+15083690414, 10/20).
  // Calls are fetched here so the voicemail fallback below reuses them.
  const calls = (await quo.listCalls({ participantE164: phone, maxResults: 10 })).data ?? [];
  const connected = (c: (typeof calls)[number]) => c.status === 'completed' && (c.duration ?? 0) > 0;
  const mattDialedOut = calls.some((c) => c.direction === 'outgoing' && connected(c));
  const oldCompletedCall = calls.some(
    (c) => connected(c) && new Date(c.createdAt).getTime() < now - 48 * 3_600_000,
  );
  if (mattDialedOut || oldCompletedCall) {
    return skip(mattDialedOut ? 'matt-called-them' : 'prior-call-episode');
  }

  // Customer's own words: inbound texts, or — when they only called
  // (2026-10-19 gap: a voicemail-only caller has zero messages, so the
  // text-only path never saw them) — the voicemail transcript.
  let customerText: string;
  let mediaCount = 0;
  let inquiryAt: string;
  if (inbound.length > 0) {
    inquiryAt = inbound.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt;
    customerText = inbound.map((m) => m.text ?? '').join('\n').trim();
    mediaCount = inbound.reduce((n, m) => n + (m.media?.length ?? 0), 0);
  } else {
    // Any incoming 0-duration call may carry a voicemail; status must
    // not gate the probe (30 of 31 measured VMs were 'no-answer').
    const candidates = calls
      .filter((c) => c.direction === 'incoming' && (c.duration ?? 0) === 0)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    let transcript: string | null = null;
    let vmAt: string | undefined;
    for (const c of candidates) {
      const vm = await quo.getCallVoicemail(c.id).catch(() => null);
      if (vm?.status === 'completed' && vm.transcript) {
        transcript = vm.transcript;
        vmAt = c.createdAt;
        break;
      }
    }
    // No VM = the call just rang out; VM without a completed transcript
    // is still processing — either way, check again next pass.
    if (!transcript || !vmAt) return { kind: 'retry-later', reason: 'no-inbound-content-yet' };
    customerText = `[voicemail transcript] ${transcript}`;
    inquiryAt = vmAt;
  }

  const ageMin = (now - new Date(inquiryAt).getTime()) / 60_000;
  // Matt's preemption window — check again next cycle
  if (ageMin < INTAKE_REPLY_WINDOW_MIN) return { kind: 'retry-later', reason: 'inside-preemption-window' };
  // Age by the inquiry itself, NOT conversation.createdAt — Quo reuses the
  // conversation created by ANY earlier touch (even a rang-out call weeks
  // ago), which made genuinely-new texters look stale (Wesley Price miss,
  // 2026-10-19: thread created 10/09 by an unanswered call).
  if (ageMin > INTAKE_THREAD_MAX_AGE_H * 60) return { kind: 'skipped', reason: 'inquiry-too-old' };

  if (SPAM_RE.test(customerText)) return skip('spam-regex');
  if (mediaCount === 0 && !REAL_LEAD_RE.test(customerText)) return skip('not-a-lead-signal');

  if (!dryRun && !(await deps.state.claimIntake(phone))) return { kind: 'skipped', reason: 'claimed-elsewhere' };

  const result = await draftIntake(gemini, {
    customerText,
    mediaCount,
    areaCode: phone.slice(2, 5),
    exemplars: pickExemplars(INTAKE_EXEMPLARS, 6, seed),
  });
  if (!result || result.classification !== 'lead') {
    return skip(result?.classification ?? 'generation-failed');
  }

  const isCt = result.propertyState === 'CT';
  let kind: string;
  let draft: string;
  let extra: string;
  let gateFail: string | null;
  if (isCt) {
    const reply = await draftCtRouting(gemini, { customerText, exemplars: pickExemplars(CT_ROUTING_EXEMPLARS, 6, seed) });
    gateFail = reply ? gateCtRouting(reply) : 'generation failed';
    kind = 'CT→LUC ROUTING';
    draft = gateFail ? ctRoutingFallback(result.extracted.name?.split(' ')[0] ?? null) : reply!;
    const mediaUrls = inbound.flatMap((m) => (m.media ?? []).map((x) => x.url)).filter(Boolean);
    extra = `CT property detected${CT_AREA_CODES.has(phone.slice(2, 5)) ? ' (CT area code)' : ''}. New inquiry ${Math.round(ageMin)} min ago, no reply yet.${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}\n\n——— HANDOFF TO LUC (copy/paste to him, then forward the photos) ———\n${buildLucHandoff({ phone, extracted: result.extracted, customerText, mediaUrls })}\n———`;
  } else {
    if (!result.draft.trim()) return skip('empty-draft');
    kind = 'FIRST-TOUCH INTAKE';
    draft = result.draft.trim();
    gateFail = gateIntake(draft, customerText, mediaCount);
    if (gateFail) draft = intakeFallback(mediaCount);
    extra = `New inquiry ${Math.round(ageMin)} min ago, no reply yet.${mediaCount ? ` ${mediaCount} photo(s) attached.` : ''}${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`;
  }

  const posted = await postDraftNote(deps, phone, kind, draft, extra);
  if (!posted) {
    // no Quo contact yet (sync usually creates one within minutes) — retry
    if (!dryRun) {
      await deps.state.releaseIntake(phone);
      const attempts = await deps.state.incrNoteAttempts(phone);
      if (attempts >= MAX_NOTE_ATTEMPTS) {
        await deps.state.setIntake(phone, 'skipped:no-quo-contact');
        await deps.state.appendRecord({ type: 'intake', phone, outcome: 'no-quo-contact-gave-up' });
        return { kind: 'skipped', reason: 'no-quo-contact-gave-up' };
      }
    }
    return { kind: 'retry-later', reason: 'no-quo-contact' };
  }
  const record: DraftRecord = {
    type: isCt ? 'ct-routing' : 'intake', phone, outcome: 'drafted', fallback: gateFail ?? null, draft,
  };
  if (!dryRun) {
    await deps.state.setIntake(phone, new Date(now).toISOString());
    await deps.state.clearNoteAttempts(phone);
    await deps.state.appendRecord(record);
  }
  return { kind: 'drafted', record };
}

/**
 * 6h conversation-poll backstop. The 1:1 participants check lives here
 * (the push path trusts the webhook's direct-message shape).
 */
export async function sweepIntake(
  deps: DraftDeps,
  opts: { maxDrafts?: number } = {},
): Promise<DraftRecord[]> {
  const now = deps.now?.() ?? Date.now();
  const convs: Array<{ id: string; createdAt: string; participants: string[] }> = [];
  let pageToken: string | undefined;
  do {
    const res = await deps.quo.listConversations({
      maxResults: 100,
      pageToken,
      updatedAfter: new Date(now - 6 * 3_600_000),
    });
    convs.push(...((res.data ?? []) as Array<{ id: string; createdAt: string; participants: string[] }>));
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);

  const records: DraftRecord[] = [];
  let drafted = 0;
  for (const c of convs) {
    if (drafted >= (opts.maxDrafts ?? Infinity)) break;
    const external = (c.participants ?? []).filter((p) => !INTERNAL.has(p));
    if (external.length !== 1 || (c.participants ?? []).length > 2) continue;
    const outcome = await processIntakePhone(deps, external[0]);
    if (outcome.kind === 'drafted') {
      records.push(outcome.record);
      drafted++;
    }
  }
  return records;
}
