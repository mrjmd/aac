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
 *  - processRoutedIntake: the inbound router's first touch, already decided
 */
import {
  AUTO_RE,
  CT_AREA_CODES,
  INTAKE_REPLY_WINDOW_MIN,
  INTAKE_THREAD_MAX_AGE_H,
  INTERNAL,
  INTAKE_MAX_PHOTOS,
  MAX_NOTE_ATTEMPTS,
  VOICEMAIL_GRACE_MIN,
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
  draftIntakeReply,
  gateCtRouting,
  gateIntake,
  intakeFallback,
  pickExemplars,
  type IntakeVerdict,
} from './voice.js';
import { CT_ROUTING_EXEMPLARS, INTAKE_EXEMPLARS } from './data/exemplars.js';
import { postDraftNote } from './note.js';
import { isDone } from './state.js';
import { easternDate } from '@aac/shared-utils/eastern';

export type IntakeOutcome =
  | { kind: 'drafted'; record: DraftRecord }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry-later'; reason: string };

/** Download up to INTAKE_MAX_PHOTOS inbound images for the intake reply to look at. */
export async function loadIntakePhotos(
  quo: DraftDeps['quo'],
  inbound: Array<{ media?: Array<{ url: string; type?: string }> }>,
): Promise<Array<{ mimeType: string; base64: string }>> {
  const imageParts: Array<{ mimeType: string; base64: string }> = [];
  for (const media of inbound.flatMap((m) => m.media ?? [])) {
    if (imageParts.length >= INTAKE_MAX_PHOTOS) break;
    if (media.type && !media.type.startsWith('image/')) continue;
    const dl = await quo.downloadMessageMedia(media.url).catch(() => null);
    if (!dl || !dl.contentType.startsWith('image/')) continue;
    imageParts.push({ mimeType: dl.contentType, base64: Buffer.from(dl.data).toString('base64') });
  }
  return imageParts;
}

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
    // is still processing. Check again next pass, but only within the grace
    // window: past it, nothing is coming. No state is written, so a later
    // text from them still re-arms the queue and drafts normally.
    if (!transcript || !vmAt) {
      const lastCallAt = Math.max(0, ...candidates.map((c) => new Date(c.createdAt).getTime()));
      return now - lastCallAt < VOICEMAIL_GRACE_MIN * 60_000
        ? { kind: 'retry-later', reason: 'no-inbound-content-yet' }
        : { kind: 'skipped', reason: 'no-voicemail' };
    }
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

  // Photos gate every step (owner, 2026-11-04): the reply is drafted
  // looking at them, against the standing can't-help rules, so a leaking
  // block bulkhead gets a kind decline instead of the name/address ask.
  const imageParts = await loadIntakePhotos(quo, inbound);
  const today = easternDate(now);
  const canHelpBlock = await deps.canHelp?.block(today).catch(() => undefined);

  const result = await draftIntake(gemini, {
    customerText,
    mediaCount,
    areaCode: phone.slice(2, 5),
    exemplars: pickExemplars(INTAKE_EXEMPLARS, 6, seed),
    imageParts,
    canHelpBlock,
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
    const verdict = result.verdict ?? 'can-help';
    kind = verdict === 'cant-help' ? "CAN'T HELP (kind decline)" : verdict === 'need-info' ? 'NEEDS ONE ANSWER FIRST' : 'FIRST-TOUCH INTAKE';
    draft = result.draft.trim();
    gateFail = gateIntake(draft, customerText, mediaCount, verdict);
    if (gateFail) draft = intakeFallback(mediaCount, verdict);
    const why = verdict !== 'can-help' && result.verdictReason ? ` Why: ${result.verdictReason}` : '';
    extra = `New inquiry ${Math.round(ageMin)} min ago, no reply yet.${mediaCount ? ` ${mediaCount} photo(s) attached${imageParts.length ? ', read' : ''}.` : ''}${why}${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`;
  }

  return postIntakeNote(deps, phone, {
    kind, draft, extra, now,
    record: { type: isCt ? 'ct-routing' : 'intake', phone, outcome: 'drafted', fallback: gateFail ?? null, draft, verdict: result.verdict ?? null },
  });
}

/**
 * Post the intake note and mark the phone done. No Quo contact yet (sync
 * usually creates one within minutes) → retry later, up to MAX_NOTE_ATTEMPTS.
 */
async function postIntakeNote(
  deps: DraftDeps,
  phone: string,
  n: { kind: string; draft: string; extra: string; now: number; record: DraftRecord },
): Promise<IntakeOutcome> {
  const { dryRun } = deps;
  const posted = await postDraftNote(deps, phone, n.kind, n.draft, n.extra);
  if (!posted) {
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
  if (!dryRun) {
    await deps.state.setIntake(phone, new Date(n.now).toISOString());
    await deps.state.clearNoteAttempts(phone);
    await deps.state.appendRecord(n.record);
  }
  return { kind: 'drafted', record: n.record };
}

/** What the inbound router hands intake: its read of the burst, already decided. */
export interface RoutedIntake {
  route: 'intake' | 'ct-routing' | 'decline';
  verdict: IntakeVerdict;
  reason: string;
  question: string | null;
  /** "Name (phone)" for each referral that fits, best first. */
  referrals: string[];
  entities: { name: string | null; address: string | null; email: string | null };
  /** The customer's inbound texts (and voicemail transcripts), oldest first. */
  customerText: string;
  mediaCount: number;
  photoNotes: string[];
  mediaUrls: string[];
  /** When this burst began, for the note's "N min ago". */
  inquiryAt: number;
  /** A case-by-case call for Matt the draft doesn't make (an out-of-state property). */
  flag?: string;
}

/**
 * Router-driven first touch (inbound router phase 4, `inbound-router:live`
 * includes intake). The router already judged lead / CT / verdict from one
 * read with the photos, so this only drafts, gates and posts. Same note
 * kinds, state and records as processIntakePhone; the record says `via: 'router'`.
 */
export async function processRoutedIntake(deps: DraftDeps, phone: string, r: RoutedIntake): Promise<IntakeOutcome> {
  const now = deps.now?.() ?? Date.now();
  const { gemini, state, dryRun } = deps;
  const seed = Math.floor(now / 600_000);
  if (isDone(await state.getIntake(phone), now)) return { kind: 'skipped', reason: 'already-done' };
  if (!dryRun && !(await state.claimIntake(phone))) return { kind: 'skipped', reason: 'claimed-elsewhere' };

  const ageMin = Math.max(0, Math.round((now - r.inquiryAt) / 60_000));
  const photos = r.mediaCount ? ` ${r.mediaCount} photo(s) attached, read.` : '';
  let kind: string;
  let draft: string;
  let extra: string;
  let gateFail: string | null;
  if (r.route === 'ct-routing') {
    const reply = await draftCtRouting(gemini, { customerText: r.customerText, exemplars: pickExemplars(CT_ROUTING_EXEMPLARS, 6, seed) });
    gateFail = reply ? gateCtRouting(reply) : 'generation failed';
    kind = 'CT→LUC ROUTING';
    draft = gateFail ? ctRoutingFallback(r.entities.name?.split(' ')[0] ?? null) : reply!;
    extra = `CT property detected${CT_AREA_CODES.has(phone.slice(2, 5)) ? ' (CT area code)' : ''}. New inquiry ${ageMin} min ago, no reply yet.${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}\n\n——— HANDOFF TO LUC (copy/paste to him, then forward the photos) ———\n${buildLucHandoff({ phone, extracted: r.entities, customerText: r.customerText, mediaUrls: r.mediaUrls })}\n———`;
  } else {
    const verdict: IntakeVerdict = r.route === 'decline' ? 'cant-help' : r.verdict;
    const reply = await draftIntakeReply(gemini, {
      customerText: r.customerText,
      mediaCount: r.mediaCount,
      photoNotes: r.photoNotes,
      exemplars: pickExemplars(INTAKE_EXEMPLARS, 6, seed),
      verdict,
      reason: r.reason,
      question: r.question,
      referrals: r.referrals,
    });
    kind = verdict === 'cant-help' ? "CAN'T HELP (kind decline)" : verdict === 'need-info' ? 'NEEDS ONE ANSWER FIRST' : 'FIRST-TOUCH INTAKE';
    gateFail = reply ? gateIntake(reply, r.customerText, r.mediaCount, verdict) : 'generation failed';
    draft = gateFail ? intakeFallback(r.mediaCount, verdict) : reply!;
    const why = verdict !== 'can-help' && r.reason ? ` Why: ${r.reason}` : '';
    const flag = r.flag && verdict !== 'cant-help' ? ` Case by case: ${r.flag}.` : '';
    extra = `New inquiry ${ageMin} min ago, no reply yet.${photos}${why}${flag}${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`;
  }
  return postIntakeNote(deps, phone, {
    kind, draft, extra, now,
    record: {
      type: r.route === 'ct-routing' ? 'ct-routing' : 'intake', via: 'router', phone, outcome: 'drafted',
      fallback: gateFail ?? null, draft, verdict: r.route === 'ct-routing' ? null : r.route === 'decline' ? 'cant-help' : r.verdict,
      ...(r.route === 'decline' ? { reason: r.reason, referrals: r.referrals } : {}),
    },
  });
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
