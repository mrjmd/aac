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
import type { QuoMessage } from '@aac/api-clients/quo';
import type { GmailMessage } from '@aac/api-clients/gmail';
import { isBotDraft } from '@aac/quoting';
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
import { analyzeThread, smsTailOf, type ThreadFacts } from './thread.js';
import {
  DAY,
  FINAL_AGE_OUT_DAYS,
  LAST_CHECKIN_AGE_DAYS,
  LAST_CHECKIN_GAP_DAYS,
  MANUAL_HOLDS,
  MAX_DRAFTS_PER_RUN,
  MAX_UNANSWERED,
  OUR_EMAILS,
  QUO_THROTTLE_MS,
  RECENT_OUTBOUND_COOLOFF_H,
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
} from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runStaleQuotes(deps: StaleQuoteDeps, opts: RunOptions): Promise<RunResult> {
  const { qb, quo, gemini, calendar, gmail, store, techEmails, log } = deps;
  const clock = deps.now ?? Date.now;
  const throttle = deps.throttleMs ?? QUO_THROTTLE_MS;
  const { dryRun, doc: docArg } = opts;
  const maxDrafts = opts.maxDrafts ?? MAX_DRAFTS_PER_RUN;

  const now = clock();
  const today = isoDay(now);

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
  if (docArg) pending = pending.filter((e) => e.DocNumber === docArg);
  // Freshest first: recent quotes are the ones a nudge can still save, so
  // the per-run draft cap goes to them before the deep-cold tail.
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
  let draftsThisRun = 0;
  let partial = false;

  for (const e of pending) {
    if (opts.deadlineMs !== undefined && clock() > opts.deadlineMs) {
      partial = true;
      log(`  time budget reached before #${e.DocNumber ?? e.Id}; the rest waits for the next run`);
      break;
    }
    const doc = e.DocNumber ?? e.Id;
    const cust = e.CustomerRef?.value ? custById.get(e.CustomerRef.value) : undefined;
    const customer = e.CustomerRef?.name ?? 'unknown';
    const custAny = cust as unknown as {
      PrimaryPhone?: { FreeFormNumber?: string };
      BillAddr?: { Line1?: string; City?: string };
    } | undefined;
    const phone = quickNormalizePhone(custAny?.PrimaryPhone?.FreeFormNumber);
    const address = `${custAny?.BillAddr?.Line1 ?? ''} ${custAny?.BillAddr?.City ?? ''}`.trim();
    const email = e.BillEmail?.Address ?? (cust as unknown as { PrimaryEmailAddr?: { Address?: string } })?.PrimaryEmailAddr?.Address ?? null;
    const quoteMs = new Date(e.TxnDate ?? e.MetaData?.CreateTime ?? now).getTime();
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

    const skip = (reason: string): void => {
      queue.skipped.push({ doc, customer, reason });
      runlog.push({ at: new Date(clock()).toISOString(), doc, customer, outcome: 'skipped', reason });
    };

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

    // ── thread + calls
    let thread: ThreadFacts = { messages: [], lastInboundAt: null, lastOutboundAt: null, unansweredTouches: 0, touchesSinceQuote: 0 };
    if (phone) {
      await sleep(throttle);
      const page = await quo.listMessages({ participantE164: phone, maxResults: 100 }).catch(() => ({ data: [] as QuoMessage[] }));
      thread = analyzeThread(page.data, quoteMs);
      await sleep(throttle);
      const calls = await quo.listCalls({ participantE164: phone, maxResults: 30 }).catch(() => ({ data: [] }));
      for (const c of calls.data) {
        const at = new Date(c.createdAt).getTime();
        if (at <= quoteMs) continue;
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

    // ── email read (gate 5 surface b): BillEmail thread + quote-notification replies.
    // Track BOTH directions: Matt replies to these threads from matt@attackacrack.com,
    // and an unanswered-customer check that only sees SMS outbound false-positives
    // (Lisa Martin #1501 showed "awaiting 1d" the day after Matt answered her by email).
    let emailTail = '';
    let lastInboundEmailAt: number | null = null;
    let lastOutboundEmailAt: number | null = null;
    let lastInboundEmailSnippet = '';
    if (email || doc) {
      const parts: string[] = [];
      if (email) parts.push(`from:${email}`, `to:${email}`);
      if (doc) parts.push(`subject:"Quote ${doc}"`);
      const q = `(${parts.join(' OR ')}) newer_than:180d -in:spam -in:trash`;
      const msgs = await gmail.listMessages({ query: q, maxResults: 15 }).catch(() => [] as GmailMessage[]);
      const human = msgs.filter((m) => m.fromAddress && !/quickbooks|intuit/i.test(m.fromAddress));
      for (const m of human) {
        const at = new Date(m.at).getTime();
        if (at <= quoteMs) continue;
        if (OUR_EMAILS.has(m.fromAddress!.toLowerCase())) {
          if (!lastOutboundEmailAt || at > lastOutboundEmailAt) lastOutboundEmailAt = at;
        } else if (!lastInboundEmailAt || at > lastInboundEmailAt) {
          lastInboundEmailAt = at;
          lastInboundEmailSnippet = (m.body || m.snippet || m.subject || '').replace(/\s+/g, ' ').slice(0, 200);
        }
      }
      emailTail = human
        .slice(0, 8)
        .reverse()
        .map((m) => `[${m.at.slice(0, 10)} ${OUR_EMAILS.has(m.fromAddress!.toLowerCase()) ? 'OUT (us)' : m.fromAddress}] ${m.subject}: ${(m.body || m.snippet).replace(/\s+/g, ' ').slice(0, 400)}`)
        .join('\n');
    }

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
      if (!lastIn) return;
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
    if (extraction?.statedTiming) {
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

    // ── stated-timing override
    if (st.statedTiming && new Date(st.statedTiming.resumeAt).getTime() > now) {
      st.suspended = { reason: 'stated-timing', detail: `"${st.statedTiming.evidence.slice(0, 100)}" → resume ${st.statedTiming.resumeAt}`, at: new Date(now).toISOString(), until: st.statedTiming.resumeAt };
      skip(`stated timing → ${st.statedTiming.resumeAt}`);
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
    if (now < dueMs) {
      skip(`${tier} due ${isoDay(dueMs)}`);
      continue;
    }

    // already queued and still unsent? re-list as waiting, don't re-draft
    const openTouch = st.touches.find((t) => !t.sentDetectedAt);
    if (openTouch) {
      queue.waiting.push({
        doc, estimateId: e.Id, customer, phone: phone!, amount, ageDays,
        tier: openTouch.tier, variant: variantLabel(st), draft: openTouch.draft,
        whyNow: `queued ${openTouch.queuedAt.slice(0, 10)}, no matching outbound detected yet — still waiting to be sent`,
        queuedAt: openTouch.queuedAt,
      });
      continue;
    }

    if (draftsThisRun >= maxDrafts) {
      skip(`due (${tier}) but per-run cap of ${maxDrafts} reached`);
      continue;
    }

    // ── draft it — but first re-check TxnStatus live: the qb-reconcile cron
    // (every 30 min) can flip Pending→Accepted/Closed mid-run without a
    // webhook, and this scan takes several minutes.
    const fresh = await qb.getEstimate(e.Id).catch(() => null);
    if (!fresh || fresh.TxnStatus !== 'Pending' || (fresh.LinkedTxn ?? []).some((t) => t.TxnType === 'Invoice')) {
      skip(`no longer Pending at draft time (${fresh?.TxnStatus ?? 'gone'})`);
      continue;
    }
    log(`\n── drafting ${tier} for ${label}`);
    const items = (e.Line ?? [])
      .filter((l) => l.DetailType === 'SalesItemLineDetail')
      .map((l) => (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } } }).SalesItemLineDetail?.ItemRef?.name ?? '')
      .filter((n) => n && !/discount|guarantee/i.test(n));
    const firstName = customer.split(/\s+/)[0];
    const quoteContext = `${items.join(', ')}${address ? ` at ${address}` : ''}`;
    // Exterior resurfacing can't honestly be offered a slot past the
    // outdoor season's end (~Nov 1) — the honest pitch is the spring list.
    const seasonEndMs = Date.UTC(new Date(now).getUTCFullYear(), 10, 1);
    const horizonText =
      svc.cls === 'exterior-resurf' && (!horizon.firstOpen || new Date(horizon.firstOpen).getTime() >= seasonEndMs)
        ? 'the outdoor resurfacing season is wrapping up for the year — we are booking spots on the early-spring list now (work resumes late Feb / March)'
        : horizon.text;
    const { systemPrompt, userPrompt } = buildDraftPrompt({
      customer, firstName, quoteDate: isoDay(quoteMs), ageDays, items, tier,
      seasonClass: svc.cls, horizonText, smsTail,
      statedTiming: st.statedTiming ? `${st.statedTiming.resumeAt} ("${st.statedTiming.evidence}")` : undefined,
      fewShots, today,
    });

    let draft = (await generateWithRetry(gemini, userPrompt, systemPrompt)).trim().replace(/^["']|["']$/g, '');
    // reviewer gate — one regeneration on failure
    for (let pass = 0; pass < 2; pass++) {
      const reviewRaw = await generateWithRetry(gemini, buildReviewPrompt(draft, horizonText, tier, quoteContext, smsTail));
      const review = parseExtractionLoose<{ ok: boolean; problems?: string[] }>(reviewRaw);
      if (review?.ok) break;
      const problems = review?.problems?.join('; ') ?? 'unparseable review';
      log(`  ⚠ reviewer flagged: ${problems}`);
      if (pass === 1) {
        skip(`draft failed review twice: ${problems}`);
        draft = '';
        break;
      }
      draft = (await generateWithRetry(gemini, `${userPrompt}\n\nYour previous draft was rejected for: ${problems}\nPrevious draft: ${draft}\nWrite a corrected version. Output ONLY the message text.`, systemPrompt)).trim().replace(/^["']|["']$/g, '');
    }
    if (!draft) continue;

    const whyNow = `${tier}${lastCheckIn ? ' (last check-in, quote over 90d)' : ''} · ${unanswered} unanswered · quote ${ageDays}d old · ${svc.cls} · ${horizonText}`;
    log(`  ${draft}`);
    log(`  why: ${whyNow}`);

    const entry: QueueDraft = {
      doc, estimateId: e.Id, customer, phone: phone!, amount, ageDays,
      tier, variant: variantLabel(st), draft, whyNow, queuedAt: new Date(clock()).toISOString(),
    };
    queue.toSend.push(entry);
    runlog.push({ at: entry.queuedAt, doc, customer, outcome: 'drafted', tier, variant: entry.variant, draft });
    draftsThisRun++;

    if (!dryRun) {
      st.touches.push({ tier, queuedAt: entry.queuedAt, draft });
      try {
        const contact = phone ? await quo.findContactByPhone(phone) : null;
        if (contact) {
          // Distinct header from the message-drafts worker's notes — Matt
          // should see at a glance which system produced a note.
          await quo.createContactNote(
            contact.id,
            `📋 STALE-QUOTE FOLLOW-UP (#${doc}, ${tier}) — copy/paste:\n\n${draft}\n\n(${whyNow})`,
          );
          log('  ✓ posted Quo note');
        } else {
          log('  ~ no Quo contact — triage listing only');
        }
      } catch (err) {
        log(`  ⚠ Quo note failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }
  }

  // prune state entries for estimates no longer Pending (converted/closed by Matt)
  const pendingIds = new Set(pending.map((e) => e.Id));
  if (!docArg) {
    for (const id of Object.keys(state.estimates)) {
      if (!pendingIds.has(id)) delete state.estimates[id];
    }
  }

  // ── write outputs
  // awaiting-human is derived, read-only data — refresh it on every full scan
  // (dry or live) so the triage report stays current between live runs. A
  // scan cut short by the time budget keeps the last full lists.
  awaitingHuman.sort((a, b) => b.amount - a.amount);
  if (!docArg && !partial) {
    await store.saveAwaiting({ generatedAt: new Date(now).toISOString(), entries: awaitingHuman });
  }
  if (!dryRun) {
    state.updatedAt = new Date(clock()).toISOString();
    await store.saveState(state);
    if (!partial) await store.saveQueue(queue);
    await store.appendRunlog(runlog);
    log(`\nSaved queue + state (+${runlog.length} runlog rows)${partial ? ' (partial scan: queue kept from the last full run)' : ''}`);
  } else {
    log(`\n[dry-run] no state/queue written, no notes posted${docArg || partial ? '' : ' (refreshed the awaiting-reply list)'}`);
  }

  return { partial, horizon: horizon.text, queue, awaiting: awaitingHuman, runlog, pendingInScope: pending.length };
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
