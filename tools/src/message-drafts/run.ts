#!/usr/bin/env npx tsx
/**
 * Message-drafts runner — Matt-voice draft texts delivered as Quo contact
 * notes for copy/paste send. NOTHING is ever sent to a customer by this
 * script; the note in the conversation panel IS the deliverable.
 *
 * Two draft types (design: analysis/02-strategy/message-automation-analysis-2026-10.md):
 *
 *  A) POST-QUOTE FOLLOW-UP — a QBO estimate was emailed (EmailStatus=
 *     EmailSent, found by polling recently-updated estimates; EmailStatus is
 *     not SQL-queryable so we filter client-side). If Matt hasn't already
 *     texted the customer since the email went out, draft the "just sent
 *     that quote over" text and post it as a contact note.
 *
 *  B) FIRST-TOUCH INTAKE ASK — a 1:1 thread with no manual reply whose first
 *     inbound (text or voicemail) is ≥10 min old (Matt's preemption window,
 *     owner-set 2026-10-19) and <48h old, classified as a real lead (not
 *     solicitation). Aged by the inquiry, never conversation.createdAt.
 *
 *  C) CT→LUC ROUTING — same trigger as (B), but the classifier determined
 *     the PROPERTY is in Connecticut (content-based; area code is only a
 *     hint — an 860 number has been an MA property and vice versa). One note
 *     carries BOTH drafts: the handoff text for Matt to send Luc (all contact
 *     info + photos pointer) and the customer reply ("you've reached the MA
 *     office, expect Luc to reach out"). Owner-requested 2026-10-19.
 *     Draft the intake reply asking only for what the customer hasn't
 *     already provided.
 *
 * Voice: few-shot generation from Matt's own 2026 sends (exemplars extracted
 * from the full-corpus harvest) + deterministic quality gates + canonical-
 * skeleton fallback. Runs every 10 min via launchd com.aac.message-drafts.
 * Flags: --dry-run (print drafts, no notes, no state writes);
 *        --probe-estimate <doc#> (dry-run the follow-up generator against one
 *        estimate, ignoring time window / done-state / already-texted check);
 *        --probe-phone <E164> (dry-run the intake generator against one
 *        thread, ignoring thread-age / reply / done-state checks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient, type QBEstimate } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { GeminiClient } from '@aac/api-clients/gemini';
import { keys, ttl } from '@aac/shared-utils/redis';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import type { QBOAuthTokens } from '@aac/shared-utils/types';

const DATA_DIR = 'analysis/data/message-drafts';
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const RUNLOG_PATH = path.join(DATA_DIR, 'runlog.jsonl');
const EXEMPLAR_DIR = 'analysis/data/message-patterns';

const OWN_LINE = '+16176681677';
const LUC_LINE = '860-573-8760'; // Luc runs the CT office; Matt texts him off-platform
const CT_AREA_CODES = new Set(['860', '203', '475', '959']);
const INTERNAL = new Set(['+18573126761', '+16177660151', OWN_LINE]);

const INTAKE_REPLY_WINDOW_MIN = 10; // Matt 2026-10-19 (was 15 in the analysis)
/** Full sweep cadence. launchd ticks every 60s; ticks between sweeps only
 *  drain the webhook-fed fast queue (one Redis call, instant follow-ups). */
const SWEEP_INTERVAL_MIN = 10;
const INTAKE_THREAD_MAX_AGE_H = 48; // the inquiry itself (first inbound) must be genuinely new
const FOLLOWUP_LOOKBACK_H = 36;
const MAX_NOTE_ATTEMPTS = 8; // ~80 min of retries waiting for a Quo contact
const MAX_DRAFTS_PER_RUN = 6;

const REAL_LEAD_RE = /crack|basement|foundation|leak|seep|water|bulkhead|quote|estimate|concrete|sump|repair|pool|patio|garage|wall|floor|cellar|slab/i;
const SPAM_RE = /hey,? it.?s \w+\.|homeowners? (in your area|looking|needing|ready)|pay.?per.?(lead|booked)|no (setup|ad) fees|mold removal (jobs|work|quotes)|ranked on google|exclusive.{0,30}(estimates|leads)|appointments? booked|min to apply|book qualified|per booked estimate|trial, no contract|send (you )?\d+ (jobs|leads|homeowners)/i;
const AUTO_RE = /apologies for missing your call|please send us a text with your name|reached out after hours|first thing when we open|this is a reminder from attack a crack|just checking back in to make sure everything/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const ADDRESS_RE = /\d+\s+\w+.{0,30}(st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|way|cir|circle|ter|terrace|pl|place|blvd)\b/i;

interface TState {
  firstRunAt?: string;
  /** Last FULL sweep (QBO 36h query + intake pass). Fast ticks don't bump it. */
  lastSweepAt?: string;
  followupDone: Record<string, string>; // estimateId → iso
  intakeDone: Record<string, string>; // phone → iso
  noteAttempts: Record<string, number>; // phone → failed findContact attempts
}

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function loadState(): TState {
  if (!fs.existsSync(STATE_PATH)) return { followupDone: {}, intakeDone: {}, noteAttempts: {} };
  return { followupDone: {}, intakeDone: {}, noteAttempts: {}, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
}
function saveState(s: TState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1));
}

function deepLink(phone: string, body: string): string {
  return `openphone://message?number=${encodeURIComponent(phone)}&from=${encodeURIComponent(OWN_LINE)}&text=${encodeURIComponent(body)}`;
}

function pickExemplars<T>(all: T[], n: number, seed: number): T[] {
  // deterministic rotation so consecutive runs vary their few-shot set
  const out: T[] = [];
  if (!all.length) return out;
  for (let i = 0; i < Math.min(n, all.length); i++) out.push(all[(seed + i * 7) % all.length]);
  return out;
}

function stripFences(text: string): string {
  return text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

// ── draft generators ─────────────────────────────────────────────

const VOICE_RULES = `You are drafting a text message AS Matt, owner of Attack A Crack (foundation crack repair, Massachusetts). Write EXACTLY as Matt writes — study the real examples provided. Hard rules:
- Never include any dollar amount, price, or discount.
- Never claim to have seen photos, visited, or spoken on the phone unless the context says so.
- Never state how far out we are booking (no "booking about a month out" style claims).
- Plain text only, no markdown. Keep Matt's warmth but his brevity too.
- Output ONLY the message text, nothing else.`;

async function draftFollowup(
  gemini: GeminiClient,
  args: { firstName: string | null; scopeLines: string[]; exemplars: Array<{ text: string }> },
): Promise<string | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's post-quote follow-up texts (for voice and shape — do not copy verbatim):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\n${e.text}`).join('\n')}

Now draft the follow-up text for THIS customer. Matt just emailed them their quote from QuickBooks.
Customer first name: ${args.firstName ?? '(unknown — use a greeting without a name)'}
What the quote covers (from the estimate's own line items — restate the scope in ONE natural sentence, in Matt's words, no prices):
${args.scopeLines.join('\n')}

Required elements: greet by first name (if known); say the quote was just sent to their email; one sentence restating what it covers; invite questions once they've had a chance to review; mention that once the quote is approved we can get them on the schedule for repair; a warm sign-off.`;
  try {
    const out = await gemini.generateContent(prompt, { maxOutputTokens: 4096 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function followupFallback(firstName: string | null, scopeSummary: string): string {
  const greet = firstName ? `Hey ${firstName}, ` : 'Hi there, ';
  return `${greet}I just sent that quote over to your email address. This is for ${scopeSummary}, and it does include our lifetime guarantee on the crack repair. Let me know if you have any questions once you've had a chance to review — as soon as the quote is approved, we can get you on the schedule for repair. Thanks, and I'll speak with you soon.`;
}

function gateFollowup(draft: string): string | null {
  if (draft.length < 120 || draft.length > 900) return `length ${draft.length}`;
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (!/quote|estimate/i.test(draft)) return 'missing quote mention';
  if (!/email/i.test(draft)) return 'missing email mention';
  if (!/review|questions/i.test(draft)) return 'missing review/questions invite';
  return null;
}

interface IntakeResult {
  classification: 'lead' | 'solicitation' | 'other';
  propertyState: 'MA' | 'CT' | 'other' | 'unknown';
  provided: { name: boolean; address: boolean; email: boolean };
  extracted: { name: string | null; address: string | null; email: string | null };
  draft: string;
}

async function draftIntake(
  gemini: GeminiClient,
  args: {
    customerText: string;
    mediaCount: number;
    areaCode: string;
    exemplars: Array<{ customer: string; text: string }>;
  },
): Promise<IntakeResult | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's first replies to new inquiries (customer message → Matt's reply):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\nCUSTOMER: ${e.customer}\nMATT: ${e.text}`).join('\n')}

A NEW inquiry just arrived on the business line. Analyze it, then draft Matt's first reply.

THE NEW INQUIRY (first message(s) from an unknown number):
${args.customerText || '(no text — photos only)'}
${args.mediaCount > 0 ? `[customer attached ${args.mediaCount} photo(s)]` : '[no photos attached]'}
[texter's area code: ${args.areaCode || 'unknown'}]

Steps:
1. Classify: "lead" (homeowner/property contact with a real issue we might service), "solicitation" (lead-gen spam, vendor pitch, marketing), or "other" (wrong number, unclear).
2. Determine the PROPERTY's state: "MA", "CT", "other", or "unknown". Judge from town/city names and addresses in the message (e.g. Cromwell, Enfield, New Britain are CT; Quincy, Braintree, Weymouth are MA). The area code is only a weak hint (CT codes: 860/203/475/959) — people move, and an 860 number has texted about an MA property. Only answer "CT" when the message content supports it.
3. Note which of these the customer ALREADY provided, and extract the values: full name, property address, email address. Use null for anything not provided.
4. If classification is "lead" AND the state is NOT "CT": draft Matt's reply. Thank them / acknowledge what they sent specifically; confirm we can help (only if the issue is plausibly crack repair / concrete work — if it's clearly outside our services, say we don't do that work); then ask ONLY for the items they have NOT already provided (full name, address of the property, email address for the quote). If they sent photos of a crack, mention the lifetime guarantee naturally. If they sent NO photos, ask for photos of the issue. End with Matt's signature line: "-- Matt at Attack A Crack".
5. If "solicitation" or "other", or the state IS "CT": draft must be an empty string (CT inquiries get a different reply drafted separately).

Return ONLY JSON: {"classification": "...", "propertyState": "...", "provided": {"name": bool, "address": bool, "email": bool}, "extracted": {"name": str|null, "address": str|null, "email": str|null}, "draft": "..."}`;
  try {
    const out = await gemini.generateContent(prompt, { maxOutputTokens: 4096 });
    const parsed = JSON.parse(stripFences(out)) as IntakeResult;
    if (!parsed || typeof parsed.draft !== 'string') return null;
    parsed.propertyState ??= 'unknown';
    parsed.extracted ??= { name: null, address: null, email: null };
    return parsed;
  } catch {
    return null;
  }
}

// ── CT→Luc routing drafts ────────────────────────────────────────

async function draftCtRouting(
  gemini: GeminiClient,
  args: { customerText: string; exemplars: Array<{ customer: string; text: string }> },
): Promise<string | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's replies to Connecticut inquiries that reached his Massachusetts line (customer message → Matt's reply):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\nCUSTOMER: ${e.customer}\nMATT: ${e.text}`).join('\n')}

A NEW Connecticut inquiry arrived on the Massachusetts business line:
${args.customerText || '(no text — photos only)'}

Draft Matt's reply. Required elements, in Matt's voice:
- Thank them / acknowledge what they sent specifically (greet by first name if they gave one).
- Let them know they've reached the Massachusetts office.
- Matt is FORWARDING their info and photos to his partner Luc, who runs the Connecticut office — do NOT ask the customer to re-send anything themselves.
- Luc will reach out; they should expect a text or call from ${LUC_LINE}.`;
  try {
    const out = await gemini.generateContent(prompt, { maxOutputTokens: 4096 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function gateCtRouting(draft: string): string | null {
  if (draft.length < 80 || draft.length > 900) return `length ${draft.length}`;
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (!draft.includes(LUC_LINE)) return "missing Luc's number";
  if (!/luc/i.test(draft)) return 'missing Luc';
  if (!/massachusetts|ma office/i.test(draft)) return 'missing MA-office mention';
  if (!/forward|pass(ing)? (this |that |it |all |your )?(along|over|on)|send(ing)? (your|all|everything)/i.test(draft)) {
    return 'not forward-style';
  }
  return null;
}

function ctRoutingFallback(firstName: string | null): string {
  const greet = firstName ? `Hi ${firstName}, thanks` : 'Hi there, thanks';
  return `${greet} for reaching out! You've actually reached the Massachusetts office. Not to worry though — I'm forwarding your info and the photos you sent over to my partner Luc, who runs our Connecticut office, and he will reach out. Keep an eye out for a text or call from him at ${LUC_LINE}. Thank you!\n\n-- Matt at Attack A Crack`;
}

/** The one-message handoff Matt sends Luc (off-platform): all contact info +
 *  the inquiry in the customer's own words + a photos pointer. */
function buildLucHandoff(args: {
  phone: string;
  extracted: { name: string | null; address: string | null; email: string | null };
  customerText: string;
  mediaUrls: string[];
}): string {
  const lines = [
    `New CT lead from the MA line:`,
    ``,
    `Name: ${args.extracted.name ?? '(not provided)'}`,
    `Cell: ${args.phone}`,
    `Address: ${args.extracted.address ?? '(not provided)'}`,
    `Email: ${args.extracted.email ?? '(not provided)'}`,
    ``,
    `Their message: "${args.customerText.slice(0, 600)}"`,
  ];
  if (args.mediaUrls.length) {
    lines.push(``, `${args.mediaUrls.length} photo(s) — forwarding separately (links may expire):`);
    lines.push(...args.mediaUrls.slice(0, 6));
  } else {
    lines.push(``, `No photos attached.`);
  }
  return lines.join('\n');
}

function gateIntake(draft: string, customerText: string, mediaCount: number): string | null {
  if (draft.length < 80 || draft.length > 1100) return `length ${draft.length}`;
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (/booking (about|around)|month out|weeks out/i.test(draft)) return 'lead-time claim';
  if (mediaCount === 0 && /thanks? for (sending|the) (photos|pictures)/i.test(draft)) return 'thanks for photos without photos';
  if (EMAIL_RE.test(customerText) && /email address where|an email address\b.{0,30}(quote|send)/i.test(draft) && !/that email|the email you/i.test(draft)) {
    return 'asks for email already provided';
  }
  return null;
}

function intakeFallback(mediaCount: number): string {
  const photoLine = mediaCount > 0
    ? 'Thanks for sending photos as well. '
    : 'Could you also send a few photos of the issue? ';
  return `Hello, thanks for reaching out! We can definitely help get this taken care of. ${photoLine}To get a quote together for you, I will just need the following information: your full name, the address of the property, and an email address where I can send the quote. Then, once I send that over, we can go over the details and any questions that you may have. Thanks!\n\n-- Matt at Attack A Crack`;
}

// ── main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const argAfter = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
  };
  const probeEstimate = argAfter('--probe-estimate');
  const probePhone = argAfter('--probe-phone');
  const dryRun = process.argv.includes('--dry-run') || !!probeEstimate || !!probePhone;
  const now = Date.now();
  const seed = Math.floor(now / 600_000); // rotates exemplar window per cycle

  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async () =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === 'OK',
      release: async () => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  });
  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });
  const gemini = new GeminiClient({ apiKey: requireEnv('GEMINI_API_KEY') });

  const followupExemplars = JSON.parse(
    fs.readFileSync(path.join(EXEMPLAR_DIR, 'exemplars-followup.json'), 'utf8'),
  ) as Array<{ text: string }>;
  const intakeExemplars = JSON.parse(
    fs.readFileSync(path.join(EXEMPLAR_DIR, 'exemplars-intake.json'), 'utf8'),
  ) as Array<{ customer: string; text: string }>;
  const ctExemplars = JSON.parse(
    fs.readFileSync(path.join(EXEMPLAR_DIR, 'exemplars-ct-routing.json'), 'utf8'),
  ) as Array<{ customer: string; text: string }>;

  // ── probe modes (manual generator testing, never posts) ────────
  if (probeEstimate) {
    const res = await qb.query<{ QueryResponse: { Estimate?: QBEstimate[] } }>(
      `SELECT * FROM Estimate WHERE DocNumber = '${probeEstimate.replace(/'/g, '')}'`,
    );
    const est = res.QueryResponse.Estimate?.[0];
    if (!est) throw new Error(`estimate #${probeEstimate} not found`);
    const customer = await qb.getCustomer(est.CustomerRef.value);
    const firstName = customer?.GivenName ?? customer?.DisplayName?.split(' ')[0] ?? null;
    const scopeLines = est.Line.filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
      .map((l) => `- ${l.SalesItemLineDetail!.ItemRef!.name}${l.Description ? `: ${l.Description.slice(0, 180)}` : ''}`);
    const draft = await draftFollowup(gemini, { firstName, scopeLines, exemplars: pickExemplars(followupExemplars, 6, seed) });
    const gateFail = draft ? gateFollowup(draft) : 'generation failed';
    console.log(`\n── probe follow-up #${est.DocNumber} (${customer?.DisplayName}) ──`);
    console.log(gateFail ? `[GATE FAIL: ${gateFail} — fallback would be used]\n` : '');
    console.log(draft ?? '(no output)');
    return;
  }
  if (probePhone) {
    const msgs = (await quo.listMessages({ participantE164: probePhone, maxResults: 50 })).data ?? [];
    const inbound = msgs.filter((m) => m.direction === 'incoming');
    let customerText = inbound.map((m) => m.text ?? '').join('\n').trim();
    const mediaCount = inbound.reduce((n, m) => n + (m.media?.length ?? 0), 0);
    if (!inbound.length) {
      // mirror the sweep's voicemail-only fallback
      const calls = (await quo.listCalls({ participantE164: probePhone, maxResults: 10 })).data ?? [];
      for (const c of calls.filter((x) => x.direction === 'incoming' && (x.duration ?? 0) === 0)) {
        const vm = await quo.getCallVoicemail(c.id);
        if (vm?.status === 'completed' && vm.transcript) {
          customerText = `[voicemail transcript] ${vm.transcript}`;
          break;
        }
      }
      if (!customerText) throw new Error('no inbound messages or voicemail on that thread');
    }
    const result = await draftIntake(gemini, {
      customerText,
      mediaCount,
      areaCode: probePhone.slice(2, 5),
      exemplars: pickExemplars(intakeExemplars, 6, seed),
    });
    console.log(`\n── probe intake ${probePhone} (classification: ${result?.classification}, state: ${result?.propertyState}, provided: ${JSON.stringify(result?.provided)}, extracted: ${JSON.stringify(result?.extracted)}) ──`);
    if (result?.classification === 'lead' && result.propertyState === 'CT') {
      const reply = await draftCtRouting(gemini, { customerText, exemplars: pickExemplars(ctExemplars, 6, seed) });
      const gateFail = reply ? gateCtRouting(reply) : 'generation failed';
      if (gateFail) console.log(`[GATE FAIL: ${gateFail} — fallback would be used]`);
      console.log('── customer reply ──');
      console.log(gateFail ? ctRoutingFallback(result.extracted.name?.split(' ')[0] ?? null) : reply);
      console.log('── handoff to Luc ──');
      const mediaUrls = inbound.flatMap((m) => (m.media ?? []).map((x) => x.url)).filter(Boolean);
      console.log(buildLucHandoff({ phone: probePhone, extracted: result.extracted, customerText, mediaUrls }));
      return;
    }
    const gateFail = result?.draft ? gateIntake(result.draft, customerText, mediaCount) : null;
    if (gateFail) console.log(`[GATE FAIL: ${gateFail} — fallback would be used]`);
    console.log(result?.draft || '(no draft — non-lead or generation failed)');
    return;
  }

  const state = loadState();
  const firstRun = !state.firstRunAt;
  if (firstRun) state.firstRunAt = new Date(now).toISOString();

  // ── fast path: quote-email events queued by the QB webhook ───────
  // Drain message-drafts:queue (LPUSH'd by /api/qb-webhook on
  // EmailSent+Pending). A tick with nothing queued and a fresh sweep
  // exits here — one Redis call, no QBO/Quo/Gemini traffic.
  const queuedRaw = (await redis.lpop<unknown>(keys.messageDraftQueue, 100)) ?? [];
  const queuedIds = [
    ...new Set(
      (Array.isArray(queuedRaw) ? queuedRaw : [queuedRaw])
        .map((q) => {
          try {
            const o = typeof q === 'string' ? JSON.parse(q) : q;
            return String((o as { estimateId?: unknown })?.estimateId ?? '');
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    ),
  ];
  const sweepDue =
    !state.lastSweepAt || now - new Date(state.lastSweepAt).getTime() >= SWEEP_INTERVAL_MIN * 60_000;
  if (queuedIds.length === 0 && !sweepDue && !dryRun) return; // quiet tick
  if (sweepDue && !dryRun) state.lastSweepAt = new Date(now).toISOString();
  if (queuedIds.length) console.log(`fast path: ${queuedIds.length} queued estimate(s)`);

  const records: Array<Record<string, unknown>> = [];
  let drafted = 0;

  const postNote = async (phone: string, kind: string, body: string, extra: string): Promise<boolean> => {
    const noteText = `🤖 ${kind} DRAFT — copy/paste to send (bot never sends):\n\n${body}\n\n———\n${extra}\nPrefill link (desktop): ${deepLink(phone, body)}`;
    if (dryRun) {
      console.log(`\n[dry-run] note for ${phone}:\n${noteText}\n`);
      return true;
    }
    const contact = await quo.findContactByPhone(phone);
    if (!contact) return false;
    await quo.createContactNote(contact.id, noteText);
    return true;
  };

  // ── A) post-quote follow-ups ───────────────────────────────────
  try {
    // Fast-queued estimates first (fetched individually); the 36h QBO
    // sweep only runs on sweep ticks, as the backstop.
    const queuedEstimates: QBEstimate[] = [];
    for (const id of queuedIds) {
      const est = await qb.getEstimate(id).catch(() => null);
      if (est) queuedEstimates.push(est);
    }
    let swept: QBEstimate[] = [];
    if (sweepDue) {
      const sinceIso = new Date(now - FOLLOWUP_LOOKBACK_H * 3_600_000).toISOString();
      const res = await qb.query<{ QueryResponse: { Estimate?: QBEstimate[] } }>(
        `SELECT * FROM Estimate WHERE MetaData.LastUpdatedTime > '${sinceIso}' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 100`,
      );
      swept = res.QueryResponse.Estimate ?? [];
    }
    const seen = new Set<string>();
    const candidates = [...queuedEstimates, ...swept].filter((e) => {
      if (seen.has(e.Id)) return false;
      seen.add(e.Id);
      return e.EmailStatus === 'EmailSent' && e.TxnStatus === 'Pending' && !state.followupDone[e.Id];
    });
    // first run: only pick up emails from the last 12h (no stale follow-ups)
    const freshEnough = (e: QBEstimate): boolean => {
      if (!firstRun) return true;
      const at = e.DeliveryInfo?.DeliveryTime ?? e.MetaData?.LastUpdatedTime;
      return !!at && now - new Date(at).getTime() < 12 * 3_600_000;
    };
    for (const est of candidates) {
      if (drafted >= MAX_DRAFTS_PER_RUN) break;
      if (!freshEnough(est)) {
        state.followupDone[est.Id] = 'skipped:stale-at-first-run';
        continue;
      }
      const customer = await qb.getCustomer(est.CustomerRef.value);
      const phone = quickNormalizePhone(customer?.PrimaryPhone?.FreeFormNumber ?? null);
      if (!phone || INTERNAL.has(phone)) {
        state.followupDone[est.Id] = 'skipped:no-phone';
        records.push({ type: 'followup', estimateId: est.Id, doc: est.DocNumber, outcome: 'no-phone' });
        continue;
      }
      // if Matt already texted them since the email went out, he's got it
      const emailedAt = new Date(est.DeliveryInfo?.DeliveryTime ?? est.MetaData?.LastUpdatedTime ?? now).getTime();
      const recent = await quo.listMessages({ participantE164: phone, maxResults: 20 });
      const mattAlready = (recent.data ?? []).some(
        (m) => m.direction === 'outgoing' && !AUTO_RE.test(m.text ?? '') && new Date(m.createdAt).getTime() > emailedAt,
      );
      if (mattAlready) {
        state.followupDone[est.Id] = 'skipped:matt-already-texted';
        records.push({ type: 'followup', estimateId: est.Id, doc: est.DocNumber, outcome: 'matt-already-texted' });
        continue;
      }
      const scopeLines = est.Line.filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
        .map((l) => `- ${l.SalesItemLineDetail!.ItemRef!.name}${l.Description ? `: ${l.Description.slice(0, 180)}` : ''}`);
      const firstName = customer?.GivenName ?? customer?.DisplayName?.split(' ')[0] ?? null;
      let draft = await draftFollowup(gemini, {
        firstName,
        scopeLines,
        exemplars: pickExemplars(followupExemplars, 6, seed),
      });
      let gateFail = draft ? gateFollowup(draft) : 'generation failed';
      if (gateFail) {
        const summary = est.Line.filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
          .map((l) => l.SalesItemLineDetail!.ItemRef!.name!.toLowerCase()).join(' + ') || 'the repair work we discussed';
        draft = followupFallback(firstName, summary);
      }
      const posted = await postNote(phone, 'POST-QUOTE FOLLOW-UP', draft!, `Quote #${est.DocNumber ?? est.Id} emailed ${new Date(emailedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}.${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`);
      if (posted) {
        if (!dryRun) state.followupDone[est.Id] = new Date(now).toISOString();
        drafted++;
        records.push({ type: 'followup', estimateId: est.Id, doc: est.DocNumber, phone, outcome: 'drafted', fallback: gateFail ?? null, draft });
        console.log(`followup drafted: #${est.DocNumber} → ${phone}${gateFail ? ` (fallback: ${gateFail})` : ''}`);
      } else {
        records.push({ type: 'followup', estimateId: est.Id, doc: est.DocNumber, phone, outcome: 'no-quo-contact' });
      }
    }
  } catch (err) {
    console.error('followup pass failed:', err);
    records.push({ type: 'followup', outcome: 'pass-error', error: String(err) });
  }

  // ── B) first-touch intake asks (sweep ticks only) ───────────────
  if (sweepDue) try {
    const convs: Array<{ id: string; createdAt: string; participants: string[] }> = [];
    let pageToken: string | undefined;
    do {
      const res = await quo.listConversations({
        maxResults: 100,
        pageToken,
        updatedAfter: new Date(now - 6 * 3_600_000),
      });
      convs.push(...((res.data ?? []) as Array<{ id: string; createdAt: string; participants: string[] }>));
      pageToken = res.nextPageToken ?? undefined;
    } while (pageToken);

    for (const c of convs) {
      if (drafted >= MAX_DRAFTS_PER_RUN) break;
      const external = (c.participants ?? []).filter((p) => !INTERNAL.has(p));
      if (external.length !== 1 || (c.participants ?? []).length > 2) continue;
      const phone = external[0];
      if (!phone?.startsWith('+') || state.intakeDone[phone]) continue;

      const msgs = (await quo.listMessages({ participantE164: phone, maxResults: 50 })).data ?? [];
      const inbound = msgs.filter((m) => m.direction === 'incoming');
      const manualOut = msgs.filter((m) => m.direction === 'outgoing' && !AUTO_RE.test(m.text ?? ''));
      if (manualOut.length > 0) {
        state.intakeDone[phone] = 'skipped:matt-replied';
        continue;
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
        const calls = (await quo.listCalls({ participantE164: phone, maxResults: 10 })).data ?? [];
        // Any incoming 0-duration call may carry a voicemail; status must
        // not gate the probe (30 of 31 measured VMs were 'no-answer').
        const candidates = calls
          .filter((c) => c.direction === 'incoming' && (c.duration ?? 0) === 0)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        let transcript: string | null = null;
        let vmAt: string | undefined;
        for (const c of candidates) {
          const vm = await quo.getCallVoicemail(c.id);
          if (vm?.status === 'completed' && vm.transcript) {
            transcript = vm.transcript;
            vmAt = c.createdAt;
            break;
          }
        }
        // No VM = the call just rang out; VM without a completed transcript
        // is still processing — either way, check again next sweep.
        if (!transcript || !vmAt) continue;
        customerText = `[voicemail transcript] ${transcript}`;
        inquiryAt = vmAt;
      }
      const ageMin = (now - new Date(inquiryAt).getTime()) / 60_000;
      if (ageMin < INTAKE_REPLY_WINDOW_MIN) continue; // Matt's preemption window — check again next cycle
      // Age by the inquiry itself, NOT conversation.createdAt — Quo reuses the
      // conversation created by ANY earlier touch (even a rang-out call weeks
      // ago), which made genuinely-new texters look stale (Wesley Price miss,
      // 2026-10-19: thread created 10/09 by an unanswered call).
      if (ageMin > INTAKE_THREAD_MAX_AGE_H * 60) continue;

      if (SPAM_RE.test(customerText)) {
        state.intakeDone[phone] = 'skipped:spam-regex';
        records.push({ type: 'intake', phone, outcome: 'spam-regex' });
        continue;
      }
      if (mediaCount === 0 && !REAL_LEAD_RE.test(customerText)) {
        state.intakeDone[phone] = 'skipped:not-a-lead-signal';
        records.push({ type: 'intake', phone, outcome: 'no-lead-signal' });
        continue;
      }

      const result = await draftIntake(gemini, {
        customerText,
        mediaCount,
        areaCode: phone.slice(2, 5),
        exemplars: pickExemplars(intakeExemplars, 6, seed),
      });
      if (!result || result.classification !== 'lead') {
        state.intakeDone[phone] = `skipped:${result?.classification ?? 'generation-failed'}`;
        records.push({ type: 'intake', phone, outcome: result?.classification ?? 'generation-failed' });
        continue;
      }

      const isCt = result.propertyState === 'CT';
      let kind: string;
      let draft: string;
      let extra: string;
      let gateFail: string | null;
      if (isCt) {
        const reply = await draftCtRouting(gemini, { customerText, exemplars: pickExemplars(ctExemplars, 6, seed) });
        gateFail = reply ? gateCtRouting(reply) : 'generation failed';
        kind = 'CT→LUC ROUTING';
        draft = gateFail ? ctRoutingFallback(result.extracted.name?.split(' ')[0] ?? null) : reply!;
        const mediaUrls = inbound.flatMap((m) => (m.media ?? []).map((x) => x.url)).filter(Boolean);
        extra = `CT property detected${CT_AREA_CODES.has(phone.slice(2, 5)) ? ' (CT area code)' : ''}. New inquiry ${Math.round(ageMin)} min ago, no reply yet.${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}\n\n——— HANDOFF TO LUC (copy/paste to him, then forward the photos) ———\n${buildLucHandoff({ phone, extracted: result.extracted, customerText, mediaUrls })}\n———`;
      } else {
        if (!result.draft.trim()) {
          state.intakeDone[phone] = 'skipped:empty-draft';
          records.push({ type: 'intake', phone, outcome: 'empty-draft' });
          continue;
        }
        kind = 'FIRST-TOUCH INTAKE';
        draft = result.draft.trim();
        gateFail = gateIntake(draft, customerText, mediaCount);
        if (gateFail) draft = intakeFallback(mediaCount);
        extra = `New inquiry ${Math.round(ageMin)} min ago, no reply yet.${mediaCount ? ` ${mediaCount} photo(s) attached.` : ''}${gateFail ? ` (fallback skeleton used: ${gateFail})` : ''}`;
      }

      const posted = await postNote(phone, kind, draft, extra);
      if (posted) {
        if (!dryRun) {
          state.intakeDone[phone] = new Date(now).toISOString();
          delete state.noteAttempts[phone];
        }
        drafted++;
        records.push({ type: isCt ? 'ct-routing' : 'intake', phone, outcome: 'drafted', fallback: gateFail ?? null, draft });
        console.log(`${isCt ? 'CT routing' : 'intake'} drafted: ${phone} (inquiry ${Math.round(ageMin)}m old${mediaCount ? `, ${mediaCount} photos` : ''})${gateFail ? ` (fallback: ${gateFail})` : ''}`);
      } else {
        // no Quo contact yet (sync usually creates one within minutes) — retry
        const attempts = (state.noteAttempts[phone] ?? 0) + 1;
        if (!dryRun) state.noteAttempts[phone] = attempts;
        if (attempts >= MAX_NOTE_ATTEMPTS) {
          if (!dryRun) state.intakeDone[phone] = 'skipped:no-quo-contact';
          records.push({ type: 'intake', phone, outcome: 'no-quo-contact-gave-up' });
        }
      }
    }
  } catch (err) {
    console.error('intake pass failed:', err);
    records.push({ type: 'intake', outcome: 'pass-error', error: String(err) });
  }

  if (!dryRun) {
    saveState(state);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      RUNLOG_PATH,
      JSON.stringify({ ranAt: new Date(now).toISOString(), dryRun, drafted, records }) + '\n',
    );
  }
  console.log(`done — ${drafted} draft(s), ${records.length} record(s)${dryRun ? ' [dry-run]' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
