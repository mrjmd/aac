/**
 * Stale-quote follow-up — one scan.
 *
 * Scans QBO Pending estimates, runs the gate chain from
 * analysis/02-strategy/stale-quote-followup-plan-2026-10.md §4.3, and for
 * estimates whose cadence slot has arrived drafts a schedule-honest,
 * price-silent follow-up SMS with Gemini. Drafts land as Quo contact
 * notes (copy/paste) and in the Redis queue the command center and the
 * triage dashboard render as "Quote follow-ups".
 *
 * Gates (all must pass before a draft):
 *   1. TxnStatus Pending, no linked/amount-matched invoice
 *   2. Calendar booking check — fuzzy name + address corroboration
 *      (booked → suspend + "flip to Accepted" flag; the 10/21 sweep
 *      caught 8 of these, one only via Eriksen/Erikson fuzzy match)
 *   3. Mike capacity policy — large resurfacing → capacity-hold
 *   4. Manual hold list (e.g. Fridman)
 *   5. Inbound suspend across ALL channels: SMS + calls/voicemail + EMAIL
 *      (QBO estimate-notification reply threads + BillEmail threads —
 *      the Daria Dellorsano case: zero Quo thread, email-only hold-off)
 *   6. Stated-timing override ("not until spring") — beats the ladder
 *   7. Season gate by service class
 *   8. Cadence ladder: T1 day 2–3 (A/B) → T2 day 10–14 (A/B) → T3 final
 *      closer → age-out; cap 3 consecutive unanswered touches
 *
 * Sends are MANUAL (Matt copy/pastes from the Quo note). Later runs detect
 * actual sends + replies from the thread and log them per A/B variant for
 * the 6-month readout.
 */
import type { QBCustomer, QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import type { GmailMessage } from '@aac/api-clients/gmail';
import { isBotDraft } from '@aac/quoting';
import { easternDate } from '@aac/shared-utils/eastern';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { assignVariant, classifyService } from './classify.js';
import { computeBookingHorizon, expandEvent, findBookedEvent } from './calendar.js';
import { FEW_SHOTS } from './few-shots.js';
import {
  buildDraftPrompt,
  buildExtractionPrompt,
  buildReviewPrompt,
  generateWithRetry,
  parseExtraction,
  parseExtractionLoose,
  type Extraction,
} from './prompts.js';
import { mergeEstimate } from './state.js';
import { analyzeThread, smsTailOf, type ThreadFacts } from './thread.js';
import {
  DAY,
  FINAL_AGE_OUT_DAYS,
  LAST_CHECKIN_AGE_DAYS,
  LAST_CHECKIN_GAP_DAYS,
  MANUAL_HOLDS,
  MAX_DRAFTS_PER_DAY,
  MAX_UNANSWERED,
  OUR_EMAILS,
  QUO_THROTTLE_MS,
  RECENT_OUTBOUND_COOLOFF_H,
  T1_VARIANTS,
  T3_GAP_DAYS,
  isoDay,
  type AwaitingHumanEntry,
  type EstimateState,
  type QueueDraft,
  type QueueFile,
  type RunOptions,
  type RunResult,
  type RunlogRow,
  type StaleQuoteDeps,
  type TouchRecord,
} from './types.js';

/** A not-yet-due quote rides along in a sibling's draft once it is this old (the earliest T1 slot). */
const T1_MIN_DAYS = Math.min(...T1_VARIANTS);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runStaleQuotes(deps: StaleQuoteDeps, opts: RunOptions): Promise<RunResult> {
  const { qb, quo, gemini, calendar, gmail, store, techEmails, log } = deps;
  const clock = deps.now ?? Date.now;
  const throttle = deps.throttleMs ?? QUO_THROTTLE_MS;
  const { dryRun, doc: docArg } = opts;
  const maxDrafts = opts.maxDrafts ?? MAX_DRAFTS_PER_DAY;

  const now = clock();
  const today = isoDay(now);
  const easternToday = easternDate(now);
  const queuedToday = (t: TouchRecord): boolean => easternDate(t.queuedAt) === easternToday;

  // ── pull everything once ───────────────────────────────────────────
  log('Pulling QBO estimates + customers + invoices…');
  const [estimates, customers, invoices] = [
    await queryAll<QBEstimate>(qb, 'Estimate'),
    await queryAll<QBCustomer>(qb, 'Customer'),
    await queryAll<QBInvoice>(qb, 'Invoice'),
  ];
  const custById = new Map(customers.map((c) => [c.Id, c]));
  const invByCustomer = new Map<string, QBInvoice[]>();
  for (const i of invoices) {
    const c = (i as unknown as { CustomerRef?: { value?: string } }).CustomerRef?.value;
    if (!c) continue;
    (invByCustomer.get(c) ?? invByCustomer.set(c, []).get(c)!).push(i);
  }

  // Bot-marked Pending drafts come from the cloud quote-drafter (apps/worker,
  // live since 10/21) and were never sent to the customer — following one up
  // would be nonsense. They can appear any minute of the day.
  let pending = estimates.filter(
    (e) =>
      e.TxnStatus === 'Pending' &&
      !(e.LinkedTxn ?? []).some((t) => t.TxnType === 'Invoice') &&
      !isBotDraft(e),
  );
  // Conversation gates are per customer, not per quote: one customer can
  // hold several Pending quotes (Jill Fairweather #1389 + #1587), and an
  // inbound on any channel suspends all of them. Grouped before the --doc
  // filter so a one-quote run still reads the whole conversation.
  const contactOf = (e: QBEstimate): Contact =>
    customerContact(e, e.CustomerRef?.value ? custById.get(e.CustomerRef.value) : undefined, now);
  const groups = groupByCustomer(pending.map((e) => ({ e, c: contactOf(e) })));
  const conversations = new Map<string, Conversation>();
  if (docArg) pending = pending.filter((e) => e.DocNumber === docArg);
  // Freshest first: recent quotes are the ones a nudge can still save, so
  // the daily draft cap goes to them before the deep-cold tail.
  pending.sort((a, b) => (b.TxnDate ?? '').localeCompare(a.TxnDate ?? ''));
  log(`  ${estimates.length} estimates → ${pending.length} Pending in scope${docArg ? ` (doc ${docArg})` : ''}`);

  log('Pulling calendar (−21d → +150d)…');
  const rawEvents = await calendar.listEvents({
    timeMin: new Date(now - 21 * DAY).toISOString(),
    timeMax: new Date(now + 150 * DAY).toISOString(),
  });
  const events = rawEvents.map(expandEvent);
  const horizon = computeBookingHorizon(events, now, techEmails);
  log(`  ${events.length} events; booking horizon: ${horizon.text}`);

  const state = await store.loadState();
  // What this run last read or wrote per estimate: a save writes only the
  // entries the run changed, merged field by field over anything another
  // writer saved meanwhile (an owner hand-set mid-run survives).
  const baseline = new Map(Object.entries(state.estimates).map(([id, st]) => [id, JSON.stringify(st)]));
  const persist = async (sts: EstimateState[]): Promise<void> => {
    const changed = sts.filter((st) => JSON.stringify(st) !== baseline.get(st.estimateId));
    if (!changed.length) return;
    const saved = await store.loadEstimates(changed.map((st) => st.estimateId));
    const merged = changed.map((st) => {
      const base = baseline.get(st.estimateId);
      const m = mergeEstimate(base ? (JSON.parse(base) as EstimateState) : undefined, st, saved[st.estimateId]);
      baseline.set(st.estimateId, JSON.stringify(m));
      return m;
    });
    await store.saveEstimates(merged);
    // The rest of the run sees the merged entry (same object the scan holds).
    for (const m of merged) {
      const st = state.estimates[m.estimateId];
      if (!st) continue;
      for (const k of Object.keys(st)) if (!(k in m)) delete (st as unknown as Record<string, unknown>)[k];
      Object.assign(st, m);
    }
  };
  const fewShots = [...FEW_SHOTS];
  const queue: QueueFile = {
    generatedAt: new Date(now).toISOString(),
    bookingHorizon: horizon.text,
    toSend: [],
    waiting: [],
    flags: [],
    skipped: [],
  };
  const runlog: RunlogRow[] = [];
  const awaitingHuman: AwaitingHumanEntry[] = [];
  const awaitingCustomers = new Set<string>();
  const readyByCustomer = new Map<string, Ready[]>();
  const skipQuote = (doc: string, customer: string, reason: string): void => {
    queue.skipped.push({ doc, customer, reason });
    runlog.push({ at: new Date(clock()).toISOString(), doc, customer, outcome: 'skipped', reason });
  };
  // The cap is per Eastern day, not per run: the worker's backstop slot
  // finishes a scan the first slot's time budget cut short, and must only
  // fill what is left of today's cap (11/06: two slots drafted 6 each). A
  // one-estimate run is an explicit request and ignores earlier drafts. A
  // combined draft is one text: it counts once, on its lead quote.
  const draftedEarlierToday = docArg
    ? 0
    : Object.values(state.estimates).reduce(
        (n, s) => n + s.touches.filter((t) => queuedToday(t) && (!t.docs || t.docs[0] === s.doc)).length,
        0,
      );
  let draftsThisRun = 0;
  let partial = false;

  for (const e of pending) {
    if (opts.deadlineMs !== undefined && clock() > opts.deadlineMs) {
      partial = true;
      log(`  time budget reached before #${e.DocNumber ?? e.Id}; the rest waits for the next run`);
      break;
    }
    const doc = e.DocNumber ?? e.Id;
    const customer = e.CustomerRef?.name ?? 'unknown';
    const { phone, address, quoteMs, key: customerKey } = contactOf(e);
    const group = groups.get(customerKey)!;
    const ageDays = Math.floor((now - quoteMs) / DAY);
    const amount = e.TotalAmt ?? 0;

    // state record (create on first sight)
    const svc = classifyService(e);
    const st: EstimateState = state.estimates[e.Id] ?? {
      estimateId: e.Id,
      doc,
      customer,
      phone,
      firstSeenAt: new Date(now).toISOString(),
      seasonClass: svc.cls,
      largeResurf: svc.largeResurf,
      variant: assignVariant(e.Id),
      touches: [],
    };
    st.phone = phone;
    st.seasonClass = svc.cls;
    st.largeResurf = svc.largeResurf;
    state.estimates[e.Id] = st;

    const skip = (reason: string): void => skipQuote(doc, customer, reason);

    const label = `#${doc} ${customer} $${amount.toLocaleString()} (${ageDays}d, ${svc.cls}${svc.largeResurf ? ' LARGE' : ''})`;

    // ── gate: manual hold
    const hold = MANUAL_HOLDS.get(doc);
    if (hold) {
      st.suspended = { reason: 'manual-hold', detail: hold.why, at: new Date(now).toISOString(), until: hold.until };
      if (hold.until && now >= new Date(hold.until).getTime()) {
        queue.flags.push({ kind: 'needs-call', doc, customer, amount, detail: `owner hold ended ${hold.until}: ${hold.why}` });
      }
      skip(`manual hold: ${hold.why}`);
      continue;
    }

    // ── gate: amount-matched invoice (quoted work already invoiced unlinked)
    const invs = e.CustomerRef?.value ? (invByCustomer.get(e.CustomerRef.value) ?? []) : [];
    const invMatch = invs.find((i) => {
      const dt = (new Date(i.TxnDate ?? 0).getTime() - quoteMs) / DAY;
      return dt >= -7 && Math.abs((i.TotalAmt ?? 0) - amount) <= Math.max(100, amount * 0.15);
    });
    if (invMatch) {
      queue.flags.push({ kind: 'flip-accepted', doc, customer, amount, detail: `invoice #${invMatch.DocNumber} (${invMatch.TxnDate}) matches amount — quote likely done; flip/close in QBO` });
      skip(`amount-matched invoice #${invMatch.DocNumber}`);
      continue;
    }

    // ── gate: booked on calendar (fuzzy + address)
    const booked = findBookedEvent(events, customer, address, now);
    if (booked) {
      st.suspended = { reason: 'booked', detail: `calendar: "${booked.summary}" ${booked.days[0]}`, at: new Date(now).toISOString() };
      queue.flags.push({ kind: 'flip-accepted', doc, customer, amount, detail: `booked on calendar: "${booked.summary}" ${booked.days[0]} → flip to Accepted` });
      skip(`booked: ${booked.summary} ${booked.days[0]}`);
      continue;
    }

    // ── gate: Mike capacity policy (large resurfacing)
    if (svc.largeResurf) {
      const size = svc.statedSqft !== null ? `${svc.statedSqft} sq ft` : `resurf lines $${svc.resurfTotal.toLocaleString()}`;
      if (st.suspended?.reason !== 'capacity-hold') {
        st.suspended = { reason: 'capacity-hold', detail: `large resurfacing (${size}) — no big resurf for Mike until tech #2`, at: new Date(now).toISOString() };
      }
      queue.flags.push({ kind: 'capacity-hold', doc, customer, amount, detail: `large resurfacing — held until tech #2 (${size})` });
      skip('capacity-hold (large resurfacing)');
      continue;
    }

    // ── the customer's whole conversation (SMS + calls + email), read once
    // per customer and shared by every Pending quote they hold. Calls and
    // email count from the customer's oldest Pending quote; the ladder's
    // touch count stays per quote (analyzeThread from this quote's date).
    let convo = conversations.get(customerKey);
    if (!convo) {
      convo = await readConversation({ quo, gmail, throttle }, group);
      conversations.set(customerKey, convo);
    }
    let thread: ThreadFacts = { messages: [], lastInboundAt: null, lastOutboundAt: null, unansweredTouches: 0, touchesSinceQuote: 0 };
    if (phone) {
      thread = analyzeThread(convo.messages, quoteMs);
      for (const c of convo.calls) {
        const at = new Date(c.createdAt).getTime();
        if (c.direction === 'incoming' && (!thread.lastInboundAt || at > thread.lastInboundAt)) thread.lastInboundAt = at;
        if (c.direction === 'outgoing' && (c.duration ?? 0) >= 40 && (!thread.lastOutboundAt || at > thread.lastOutboundAt)) thread.lastOutboundAt = at;
      }
    }

    // ── sent/reply detection for previously queued drafts (A/B logging)
    for (const t of st.touches) {
      if (!t.sentDetectedAt) {
        const sent = thread.messages.find(
          (m) => m.direction === 'outgoing' && new Date(m.createdAt).getTime() >= new Date(t.queuedAt).getTime(),
        );
        if (sent) t.sentDetectedAt = sent.createdAt;
      }
      if (t.sentDetectedAt && t.repliedWithin7d === undefined) {
        const sentMs = new Date(t.sentDetectedAt).getTime();
        const replied = thread.messages.some(
          (m) => m.direction === 'incoming' && new Date(m.createdAt).getTime() > sentMs && new Date(m.createdAt).getTime() <= sentMs + 7 * DAY,
        );
        if (replied) t.repliedWithin7d = true;
        else if (now > sentMs + 7 * DAY) t.repliedWithin7d = false;
      }
    }

    // ── email (gate 5 surface b): every BillEmail/PrimaryEmail and "Quote N"
    // thread of this customer. Track BOTH directions: Matt replies to these
    // threads from matt@attackacrack.com, and an unanswered-customer check
    // that only sees SMS outbound false-positives (Lisa Martin #1501 showed
    // "awaiting 1d" the day after Matt answered her by email).
    let lastInboundEmailAt: number | null = null;
    let lastOutboundEmailAt: number | null = null;
    let lastInboundEmailSnippet = '';
    for (const m of convo.emails) {
      const at = new Date(m.at).getTime();
      if (OUR_EMAILS.has(m.fromAddress!.toLowerCase())) {
        if (!lastOutboundEmailAt || at > lastOutboundEmailAt) lastOutboundEmailAt = at;
      } else if (!lastInboundEmailAt || at > lastInboundEmailAt) {
        lastInboundEmailAt = at;
        lastInboundEmailSnippet = (m.body || m.snippet || m.subject || '').replace(/\s+/g, ' ').slice(0, 200);
      }
    }
    const emailTail = convo.emailTail;

    // ── gate: no channel at all
    if (!phone && !thread.messages.length) {
      if (lastInboundEmailAt || emailTail) {
        // email-only customer (the Daria case): extract timing, flag once, never SMS
        const extraction = await extractIfNeeded({ gemini, st, thread, emailTail, e, customer, today, lastInboundMs: lastInboundEmailAt });
        const timing = extraction?.statedTiming ? ` — stated timing: ${extraction.statedTiming.resumeAt} ("${extraction.statedTiming.evidence}")` : '';
        queue.flags.push({ kind: 'needs-call', doc, customer, amount, detail: `no SMS channel — email/call only, Matt handles outbound${timing}` });
        skip('no SMS channel (email-only)');
      } else {
        queue.flags.push({ kind: 'needs-call', doc, customer, amount, detail: 'no SMS channel, no email thread — needs a call' });
        skip('no SMS channel');
      }
      continue;
    }

    // ── inbound-suspend: anything inbound newer than our last outbound
    // (both sides merge SMS + email — comparing cross-channel is the point)
    const lastIn = Math.max(thread.lastInboundAt ?? 0, lastInboundEmailAt ?? 0) || null;
    const lastOut = Math.max(thread.lastOutboundAt ?? 0, lastOutboundEmailAt ?? 0) || null;
    const pushAwaiting = (): void => {
      // one entry per customer: the freshest quote (scanned first) stands for the conversation
      if (!lastIn || awaitingCustomers.has(customerKey)) return;
      awaitingCustomers.add(customerKey);
      const viaEmail = Boolean(lastInboundEmailAt && (!thread.lastInboundAt || lastInboundEmailAt > thread.lastInboundAt));
      const lastInSms = [...thread.messages].reverse().find((m) => m.direction !== 'outgoing' && m.text);
      awaitingHuman.push({
        doc,
        customer,
        phone: phone ?? '',
        amount,
        channel: viaEmail ? 'email' : 'sms',
        lastInboundAt: isoDay(lastIn),
        daysWaiting: Math.floor((now - lastIn) / DAY),
        snippet: viaEmail ? lastInboundEmailSnippet : (lastInSms?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
      });
    };
    const smsTail = smsTailOf(thread.messages);

    // extraction (intent / stated timing / human topics) when there's fresh inbound
    const extraction = await extractIfNeeded({ gemini, st, thread, emailTail, e, customer, today, lastInboundMs: lastIn, smsTail });

    if (
      extraction &&
      (extraction.intent === 'declined' || extraction.intent === 'went-elsewhere') &&
      extraction.confidence === 'high' &&
      extraction.evidence?.trim()
    ) {
      st.closedFlag = { kind: 'declined', detail: extraction.evidence, at: new Date(now).toISOString() };
      queue.flags.push({ kind: 'recommend-close', doc, customer, amount, detail: `customer ${extraction.intent === 'went-elsewhere' ? 'went elsewhere' : 'declined'} — "${extraction.evidence.slice(0, 160)}" → Reject in QBO` });
      skip(`recommend-close (${extraction.intent})`);
      continue;
    }
    if (extraction?.humanTopic) {
      st.suspended = { reason: 'awaiting-human', detail: 'human-only topic in thread (price/complaint/payment)', at: new Date(now).toISOString() };
      if (lastIn && (!lastOut || lastIn > lastOut)) pushAwaiting();
      skip('human-only topic');
      continue;
    }
    // A stated timing recorded after this inbound (an owner hand-set, or an
    // extraction from a later run) is newer evidence: keep it.
    const timingIsNewer = Boolean(lastIn && st.statedTiming && new Date(st.statedTiming.extractedAt).getTime() >= lastIn);
    if (extraction?.statedTiming && !timingIsNewer) {
      st.statedTiming = { ...extraction.statedTiming, channel: lastInboundEmailAt && (!thread.lastInboundAt || lastInboundEmailAt > thread.lastInboundAt) ? 'email' : 'sms', extractedAt: new Date(now).toISOString() };
    }

    // Customer spoke last. Only a real unanswered question waits on Matt; a
    // polite sign-off ("thanks, I'll get back to you") lets the ladder run.
    if (lastIn && (!lastOut || lastIn > lastOut) && st.lastInboundNeedsReply !== false) {
      st.suspended = { reason: 'awaiting-human', detail: `inbound ${isoDay(lastIn)} not yet answered — human replies first`, at: new Date(now).toISOString() };
      pushAwaiting();
      skip(`awaiting human reply (inbound ${isoDay(lastIn)})`);
      continue;
    }
    if (lastIn && now - lastIn < 7 * DAY) {
      skip(`active conversation (inbound ${isoDay(lastIn)})`);
      continue;
    }
    st.suspended = undefined; // survived the suspend gates

    // ── stated-timing override: this quote's, else the latest one the
    // customer gave on any of their other Pending quotes (read, never copied)
    const timing = activeTiming(st, now) ?? siblingTiming(group, e.Id, state.estimates, now);
    if (timing) {
      const via = timing.doc === doc ? '' : ` (said on #${timing.doc})`;
      st.suspended = { reason: 'stated-timing', detail: `"${timing.evidence.slice(0, 100)}" → resume ${timing.resumeAt}${via}`, at: new Date(now).toISOString(), until: timing.resumeAt };
      skip(`stated timing → ${timing.resumeAt}${via}`);
      continue;
    }

    // ── season gate (small exterior resurf in the off-season)
    const month = new Date(now).getUTCMonth() + 1;
    if (svc.cls === 'exterior-resurf' && (month >= 11 || month <= 2)) {
      const resume = month >= 11 ? `${new Date(now).getUTCFullYear() + 1}-02-23` : `${new Date(now).getUTCFullYear()}-02-23`;
      st.suspended = { reason: 'season', detail: `exterior resurfacing off-season → resume ${resume}`, at: new Date(now).toISOString(), until: resume };
      skip(`season → ${resume}`);
      continue;
    }
    if (svc.cls === 'pool-deck' && (month >= 10 || month === 1)) {
      st.suspended = { reason: 'season', detail: 'pool deck dormant Oct–Jan', at: new Date(now).toISOString(), until: `${month >= 10 ? new Date(now).getUTCFullYear() + 1 : new Date(now).getUTCFullYear()}-02-15` };
      skip('season (pool deck dormant)');
      continue;
    }

    // ── cooloff: Matt texted them very recently
    if (lastOut && now - lastOut < RECENT_OUTBOUND_COOLOFF_H * 3_600_000) {
      skip(`outbound ${isoDay(lastOut)} — cooloff`);
      continue;
    }

    // ── final touch already sent: wait it out, then recommend close
    const finalSent = st.touches.filter((t) => t.tier === 'T3' && t.sentDetectedAt).pop();
    if (finalSent && !(lastIn && lastIn > new Date(finalSent.sentDetectedAt!).getTime())) {
      if (now - new Date(finalSent.sentDetectedAt!).getTime() > FINAL_AGE_OUT_DAYS * DAY) {
        st.closedFlag = { kind: 'age-out', detail: `final touch ${finalSent.sentDetectedAt!.slice(0, 10)} unanswered ${FINAL_AGE_OUT_DAYS}d+`, at: new Date(now).toISOString() };
        queue.flags.push({ kind: 'recommend-close', doc, customer, amount, detail: `final check-in ${finalSent.sentDetectedAt!.slice(0, 10)} unanswered ${FINAL_AGE_OUT_DAYS}d+ → Close in QBO` });
        skip('final touch aged out — recommend close');
      } else {
        skip(`final touch sent ${finalSent.sentDetectedAt!.slice(0, 10)} — waiting ${FINAL_AGE_OUT_DAYS}d`);
      }
      continue;
    }

    // ── cadence ladder
    const unanswered = thread.unansweredTouches;
    if (unanswered >= MAX_UNANSWERED) {
      const finalTouch = st.touches.filter((t) => t.tier === 'T3' && t.sentDetectedAt).pop();
      if (finalTouch && now - new Date(finalTouch.sentDetectedAt!).getTime() > FINAL_AGE_OUT_DAYS * DAY) {
        st.closedFlag = { kind: 'age-out', detail: `final touch ${finalTouch.sentDetectedAt!.slice(0, 10)} unanswered ${FINAL_AGE_OUT_DAYS}d+`, at: new Date(now).toISOString() };
        queue.flags.push({ kind: 'recommend-close', doc, customer, amount, detail: `3 unanswered touches, final aged out → Close in QBO` });
      }
      skip(`${unanswered} unanswered touches — cap reached`);
      continue;
    }

    const lastCheckIn = ageDays > LAST_CHECKIN_AGE_DAYS;
    const tier: 'T1' | 'T2' | 'T3' = lastCheckIn ? 'T3' : unanswered === 0 ? 'T1' : unanswered === 1 ? 'T2' : 'T3';
    const anchor = lastOut ?? quoteMs;
    const dueMs = lastCheckIn
      ? anchor + LAST_CHECKIN_GAP_DAYS * DAY
      : tier === 'T1'
        ? quoteMs + st.variant.t1Days * DAY
        : tier === 'T2'
          ? Math.max(quoteMs + st.variant.t2Days * DAY, anchor + 7 * DAY)
          : anchor + T3_GAP_DAYS * DAY;
    // Due or not, the draft decision is per customer, after the scan.
    const ready: Ready = {
      e, st, doc, customer, phone: phone!, amount, ageDays, quoteMs, address, svc, label,
      tier, dueMs, lastCheckIn, unanswered, smsTail,
    };
    (readyByCustomer.get(customerKey) ?? readyByCustomer.set(customerKey, []).get(customerKey)!).push(ready);
  }

  // ── one draft per customer: every quote of theirs that passed the gates
  // and is due goes into one text, and quotes that passed the gates but are
  // not due yet (at least T1_MIN_DAYS old) ride along, so the customer
  // never gets two nudges a few days apart. Each quote records the touch at
  // its own tier, so their ladders advance together.
  for (const members of readyByCustomer.values()) {
    const notDueYet = (m: Ready): void => skipQuote(m.doc, m.customer, `${m.tier} due ${isoDay(m.dueMs)}`);
    const isDue = (m: Ready): boolean => now >= m.dueMs;
    const openOf = (m: Ready): TouchRecord | undefined => m.st.touches.find((t) => !t.sentDetectedAt);
    const due = members.filter(isDue);
    if (!due.length) {
      members.forEach(notDueYet);
      continue;
    }

    // already queued and still unsent? never re-draft, for any of their
    // quotes. Queued earlier today (a rerun of today's scan) → still today's
    // draft, listed to send; queued on an earlier day → waiting.
    const lead = due.find(openOf) ?? members.find(openOf);
    if (lead) {
      const open = openOf(lead)!;
      const covered = members.filter((m) => openOf(m)?.queuedAt === open.queuedAt);
      const listed: QueueDraft = {
        doc: lead.doc, estimateId: lead.e.Id, customer: lead.customer, phone: lead.phone,
        amount: covered.reduce((n, m) => n + m.amount, 0), ageDays: lead.ageDays,
        tier: open.tier, variant: variantLabel(lead.st), draft: open.draft,
        whyNow: `queued ${open.queuedAt.slice(0, 10)}, no matching outbound detected yet — still waiting to be sent`,
        queuedAt: open.queuedAt,
        ...(open.docs ? { docs: open.docs } : {}),
      };
      if (queuedToday(open)) {
        queue.toSend.push({ ...listed, whyNow: open.whyNow ?? `${open.tier} drafted earlier today` });
      } else {
        queue.waiting.push(listed);
      }
      for (const m of due) if (!covered.includes(m)) skipQuote(m.doc, m.customer, `waiting on the unsent draft for #${lead.doc}`);
      members.filter((m) => !isDue(m) && !covered.includes(m)).forEach(notDueYet);
      continue;
    }

    if (draftedEarlierToday + draftsThisRun >= maxDrafts) {
      for (const m of due) skipQuote(m.doc, m.customer, `due (${m.tier}) but daily cap of ${maxDrafts} reached`);
      members.filter((m) => !isDue(m)).forEach(notDueYet);
      continue;
    }
    if (opts.deadlineMs !== undefined && clock() > opts.deadlineMs) {
      partial = true;
      log(`  time budget reached before #${due[0].doc}; the rest waits for the next run`);
      break;
    }

    const riders = members.filter((m) => !isDue(m) && m.ageDays >= T1_MIN_DAYS && !openOf(m));
    members.filter((m) => !isDue(m) && !riders.includes(m)).forEach(notDueYet);

    // ── draft it — but first re-check TxnStatus live: the qb-reconcile cron
    // (every 30 min) can flip Pending→Accepted/Closed mid-run without a
    // webhook, and this scan takes several minutes.
    const live: Ready[] = [];
    for (const m of [...due, ...riders]) {
      const fresh = await qb.getEstimate(m.e.Id).catch(() => null);
      if (!fresh || fresh.TxnStatus !== 'Pending' || (fresh.LinkedTxn ?? []).some((t) => t.TxnType === 'Invoice')) {
        skipQuote(m.doc, m.customer, `no longer Pending at draft time (${fresh?.TxnStatus ?? 'gone'})`);
      } else {
        live.push(m);
      }
    }
    if (!live.some(isDue)) {
      live.forEach(notDueYet);
      continue;
    }
    const head = live[0];
    const { st, doc, customer, phone, svc } = head;
    // The gentlest tier among them sets the tone: a "closing out the quote"
    // final touch only when every quote in the text is on its final touch.
    const tier = live.map((m) => m.tier).sort()[0];
    const lastCheckIn = live.every((m) => m.lastCheckIn);
    const docs = live.map((m) => m.doc);
    log(`\n── drafting ${tier} for ${live.map((m) => m.label).join(' + ')}`);
    const quotes = live.map((m) => ({ quoteDate: isoDay(m.quoteMs), ageDays: m.ageDays, items: itemNames(m.e), address: m.address }));
    const firstName = customer.split(/\s+/)[0];
    const quoteContext = quotes
      .map((q) => `${q.items.join(', ')}${q.address ? ` at ${q.address}` : ''}`)
      .join(live.length > 1 ? ' | and, in the same text: ' : '');
    // Exterior resurfacing can't honestly be offered a slot past the
    // outdoor season's end (~Nov 1) — the honest pitch is the spring list.
    const seasonEndMs = Date.UTC(new Date(now).getUTCFullYear(), 10, 1);
    const horizonText =
      svc.cls === 'exterior-resurf' && (!horizon.firstOpen || new Date(horizon.firstOpen).getTime() >= seasonEndMs)
        ? 'the outdoor resurfacing season is wrapping up for the year — we are booking spots on the early-spring list now (work resumes late Feb / March)'
        : horizon.text;
    const { systemPrompt, userPrompt } = buildDraftPrompt({
      customer, firstName, quotes, tier,
      seasonClass: svc.cls, horizonText, smsTail: head.smsTail,
      statedTiming: st.statedTiming ? `${st.statedTiming.resumeAt} ("${st.statedTiming.evidence}")` : undefined,
      fewShots, today,
    });

    let draft = (await generateWithRetry(gemini, userPrompt, systemPrompt)).trim().replace(/^["']|["']$/g, '');
    // reviewer gate — one regeneration on failure
    for (let pass = 0; pass < 2; pass++) {
      const reviewRaw = await generateWithRetry(gemini, buildReviewPrompt(draft, horizonText, tier, quoteContext, head.smsTail));
      const review = parseExtractionLoose<{ ok: boolean; problems?: string[] }>(reviewRaw);
      if (review?.ok) break;
      const problems = review?.problems?.join('; ') ?? 'unparseable review';
      log(`  ⚠ reviewer flagged: ${problems}`);
      if (pass === 1) {
        for (const m of live) skipQuote(m.doc, m.customer, `draft failed review twice: ${problems}`);
        draft = '';
        break;
      }
      draft = (await generateWithRetry(gemini, `${userPrompt}\n\nYour previous draft was rejected for: ${problems}\nPrevious draft: ${draft}\nWrite a corrected version. Output ONLY the message text.`, systemPrompt)).trim().replace(/^["']|["']$/g, '');
    }
    if (!draft) continue;

    const together = live.length > 1 ? ` · one text for ${docs.map((d) => `#${d}`).join(' + ')}` : '';
    const whyNow = `${tier}${lastCheckIn ? ' (last check-in, quote over 90d)' : ''} · ${head.unanswered} unanswered · quote ${head.ageDays}d old · ${svc.cls} · ${horizonText}${together}`;
    log(`  ${draft}`);
    log(`  why: ${whyNow}`);

    const entry: QueueDraft = {
      doc, estimateId: head.e.Id, customer, phone, amount: live.reduce((n, m) => n + m.amount, 0), ageDays: head.ageDays,
      tier, variant: variantLabel(st), draft, whyNow, queuedAt: new Date(clock()).toISOString(),
      ...(live.length > 1 ? { docs } : {}),
    };
    queue.toSend.push(entry);
    runlog.push({ at: entry.queuedAt, doc, ...(entry.docs ? { docs } : {}), customer, outcome: 'drafted', tier, variant: entry.variant, draft });
    draftsThisRun++;

    if (!dryRun) {
      // Save the touches before posting: a run killed mid-scan (maxDuration)
      // never reaches the final save, and the next slot would draft it again.
      for (const m of live) m.st.touches.push({ tier: m.tier, queuedAt: entry.queuedAt, draft, whyNow, ...(entry.docs ? { docs } : {}) });
      await persist(live.map((m) => m.st));
      try {
        const contact = phone ? await quo.findContactByPhone(phone) : null;
        if (contact) {
          // Distinct header from the message-drafts worker's notes — Matt
          // should see at a glance which system produced a note.
          await quo.createContactNote(
            contact.id,
            `📋 STALE-QUOTE FOLLOW-UP (${docs.map((d) => `#${d}`).join(' + ')}, ${tier}) — copy/paste:\n\n${draft}\n\n(${whyNow})`,
          );
          log('  ✓ posted Quo note');
        } else {
          log('  ~ no Quo contact — triage listing only');
        }
      } catch (err) {
        log(`  ⚠ Quo note failed: ${(err as Error).message.slice(0, 80)}`);
        await deps.countCondition?.('stale-quotes.note_failed');
      }
    }
  }

  // prune state entries for estimates no longer Pending (converted/closed by
  // Matt); only entries this run loaded, never one written since it began
  const pendingIds = new Set(pending.map((e) => e.Id));
  const pruned = docArg ? [] : [...baseline.keys()].filter((id) => !pendingIds.has(id));

  // ── write outputs
  // awaiting-human is derived, read-only data — refresh it on every full scan
  // (dry or live) so the triage report stays current between live runs. A
  // scan cut short by the time budget keeps the last full lists.
  awaitingHuman.sort((a, b) => b.amount - a.amount);
  if (!docArg && !partial) {
    await store.saveAwaiting({ generatedAt: new Date(now).toISOString(), entries: awaitingHuman });
  }
  if (!dryRun) {
    await persist(Object.values(state.estimates).filter((st) => !pruned.includes(st.estimateId)));
    await store.deleteEstimates(pruned);
    if (!partial) await store.saveQueue(queue);
    await store.appendRunlog(runlog);
    log(`\nSaved queue + state (+${runlog.length} runlog rows)${partial ? ' (partial scan: queue kept from the last full run)' : ''}`);
  } else {
    log(`\n[dry-run] no state/queue written, no notes posted${docArg || partial ? '' : ' (refreshed the awaiting-reply list)'}`);
  }

  return { partial, horizon: horizon.text, queue, awaiting: awaitingHuman, runlog, pendingInScope: pending.length, draftedThisRun: draftsThisRun };
}

/** A quote that passed every gate: due now, or only waiting on its ladder slot. */
interface Ready {
  e: QBEstimate;
  st: EstimateState;
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  ageDays: number;
  quoteMs: number;
  address: string;
  svc: ReturnType<typeof classifyService>;
  label: string;
  tier: 'T1' | 'T2' | 'T3';
  dueMs: number;
  lastCheckIn: boolean;
  unanswered: number;
  smsTail: string;
}

function itemNames(e: QBEstimate): string[] {
  return (e.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } } }).SalesItemLineDetail?.ItemRef?.name ?? '')
    .filter((n) => n && !/discount|guarantee/i.test(n));
}

interface Contact {
  /** QBO customer id, else the phone, else the estimate: whose conversation this is. */
  key: string;
  phone: string | null;
  email: string | null;
  address: string;
  quoteMs: number;
}

interface CustomerGroup {
  key: string;
  phone: string | null;
  emails: Set<string>;
  docs: Set<string>;
  estimateIds: string[];
  /** The oldest Pending quote's date: calls and email count from here. */
  fromMs: number;
}

interface Conversation {
  messages: QuoMessage[];
  calls: QuoCall[];
  /** Human (non-QuickBooks) email after fromMs, newest first. */
  emails: GmailMessage[];
  emailTail: string;
}

function customerContact(e: QBEstimate, cust: QBCustomer | undefined, now: number): Contact {
  const custAny = cust as unknown as {
    PrimaryPhone?: { FreeFormNumber?: string };
    BillAddr?: { Line1?: string; City?: string };
    PrimaryEmailAddr?: { Address?: string };
  } | undefined;
  const phone = quickNormalizePhone(custAny?.PrimaryPhone?.FreeFormNumber);
  return {
    key: e.CustomerRef?.value ? `c:${e.CustomerRef.value}` : phone ? `p:${phone}` : `e:${e.Id}`,
    phone,
    email: e.BillEmail?.Address ?? custAny?.PrimaryEmailAddr?.Address ?? null,
    address: `${custAny?.BillAddr?.Line1 ?? ''} ${custAny?.BillAddr?.City ?? ''}`.trim(),
    quoteMs: new Date(e.TxnDate ?? e.MetaData?.CreateTime ?? now).getTime(),
  };
}

function groupByCustomer(rows: Array<{ e: QBEstimate; c: Contact }>): Map<string, CustomerGroup> {
  const groups = new Map<string, CustomerGroup>();
  for (const { e, c } of rows) {
    let g = groups.get(c.key);
    if (!g) {
      g = { key: c.key, phone: c.phone, emails: new Set(), docs: new Set(), estimateIds: [], fromMs: c.quoteMs };
      groups.set(c.key, g);
    }
    g.phone ??= c.phone;
    if (c.email) g.emails.add(c.email.toLowerCase());
    g.docs.add(e.DocNumber ?? e.Id);
    g.estimateIds.push(e.Id);
    g.fromMs = Math.min(g.fromMs, c.quoteMs);
  }
  return groups;
}

async function readConversation(
  io: { quo: StaleQuoteDeps['quo']; gmail: StaleQuoteDeps['gmail']; throttle: number },
  g: CustomerGroup,
): Promise<Conversation> {
  let messages: QuoMessage[] = [];
  let calls: QuoCall[] = [];
  if (g.phone) {
    await sleep(io.throttle);
    messages = (await io.quo.listMessages({ participantE164: g.phone, maxResults: 100 }).catch(() => ({ data: [] as QuoMessage[] }))).data;
    await sleep(io.throttle);
    calls = (await io.quo.listCalls({ participantE164: g.phone, maxResults: 30 }).catch(() => ({ data: [] as QuoCall[] }))).data
      .filter((c) => new Date(c.createdAt).getTime() > g.fromMs);
  }
  const parts: string[] = [];
  for (const em of g.emails) parts.push(`from:${em}`, `to:${em}`);
  for (const d of g.docs) parts.push(`subject:"Quote ${d}"`);
  const q = `(${parts.join(' OR ')}) newer_than:180d -in:spam -in:trash`;
  const msgs = await io.gmail.listMessages({ query: q, maxResults: 15 }).catch(() => [] as GmailMessage[]);
  const human = msgs.filter((m) => m.fromAddress && !/quickbooks|intuit/i.test(m.fromAddress));
  const emails = human.filter((m) => new Date(m.at).getTime() > g.fromMs);
  const emailTail = human
    .slice(0, 8)
    .reverse()
    .map((m) => `[${m.at.slice(0, 10)} ${OUR_EMAILS.has(m.fromAddress!.toLowerCase()) ? 'OUT (us)' : m.fromAddress}] ${m.subject}: ${(m.body || m.snippet).replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
  return { messages, calls, emails, emailTail };
}

interface ActiveTiming {
  resumeAt: string;
  evidence: string;
  doc: string;
}

function activeTiming(st: EstimateState | undefined, now: number): ActiveTiming | null {
  if (!st?.statedTiming || new Date(st.statedTiming.resumeAt).getTime() <= now) return null;
  return { resumeAt: st.statedTiming.resumeAt, evidence: st.statedTiming.evidence, doc: st.doc };
}

/** The latest still-future stated timing on the customer's other Pending quotes. */
function siblingTiming(g: CustomerGroup, selfId: string, estimates: Record<string, EstimateState>, now: number): ActiveTiming | null {
  let best: ActiveTiming | null = null;
  for (const id of g.estimateIds) {
    if (id === selfId) continue;
    const t = activeTiming(estimates[id], now);
    if (t && (!best || t.resumeAt > best.resumeAt)) best = t;
  }
  return best;
}

function variantLabel(st: EstimateState): string {
  return `T1@${st.variant.t1Days}d/T2@${st.variant.t2Days}d`;
}

/** Run the intent/timing extraction only when there is inbound content the
 *  extractor hasn't seen yet (cached by last-inbound timestamp in state). */
async function extractIfNeeded(input: {
  gemini: StaleQuoteDeps['gemini'];
  st: EstimateState;
  thread: ThreadFacts;
  emailTail: string;
  e: QBEstimate;
  customer: string;
  today: string;
  lastInboundMs: number | null;
  smsTail?: string;
}): Promise<Extraction | null> {
  const { st, lastInboundMs } = input;
  if (!lastInboundMs) return null;
  const lastInboundIso = new Date(lastInboundMs).toISOString();
  // already processed (re-run once for entries cached before needsReply existed)
  if (st.lastExtractedInboundAt === lastInboundIso && st.lastInboundNeedsReply !== undefined) return null;
  const smsTail = input.smsTail ?? smsTailOf(input.thread.messages);
  const items = (input.e.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } } }).SalesItemLineDetail?.ItemRef?.name ?? '')
    .filter(Boolean);
  const raw = await generateWithRetry(
    input.gemini,
    buildExtractionPrompt({
      customer: input.customer,
      quoteDate: input.e.TxnDate ?? '',
      items,
      smsTail,
      emailTail: input.emailTail,
      today: input.today,
    }),
  );
  const extraction = parseExtraction(raw);
  if (extraction) {
    st.lastExtractedInboundAt = lastInboundIso;
    st.lastInboundNeedsReply = extraction.needsReply;
  }
  return extraction;
}

/** QBO's cap on one query page. */
const QBO_PAGE_SIZE = 1000;

async function queryAll<T>(qb: StaleQuoteDeps['qb'], entity: string): Promise<T[]> {
  const all: T[] = [];
  let start = 1;
  for (;;) {
    const res = await qb.query<{ QueryResponse: Record<string, T[] | undefined> }>(
      `SELECT * FROM ${entity} ORDER BY MetaData.CreateTime STARTPOSITION ${start} MAXRESULTS ${QBO_PAGE_SIZE}`,
    );
    const page = res.QueryResponse[entity] ?? [];
    all.push(...page);
    if (page.length < QBO_PAGE_SIZE) break;
    start += QBO_PAGE_SIZE;
  }
  return all;
}
