#!/usr/bin/env npx tsx
/**
 * Stale-quote follow-up — Phase 1 assisted batch.
 *
 * Scans QBO Pending estimates, runs the gate chain from
 * analysis/02-strategy/stale-quote-followup-plan-2026-10.md §4.3, and for
 * estimates whose cadence slot has arrived drafts a schedule-honest,
 * price-silent follow-up SMS with Gemini. Drafts land as Quo contact
 * notes (copy/paste) and in analysis/data/stale-quotes/draft-queue.json,
 * which the triage dashboard renders as "Quote follow-ups".
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
 * Sends are MANUAL (Matt copy/pastes from the Quo note / triage). The
 * script detects actual sends + replies from the thread on later runs
 * and logs them per A/B variant for the 6-month readout.
 *
 * NO contact with apps/middleware, the message-drafts worker, or QStash —
 * the launchd→workers migration (other agent) is untouched. Phase 2 moves
 * this logic into packages + a server worker after that migration lands.
 *
 * Usage (repo root):
 *   npx tsx tools/src/stale-quotes/run.ts --dry-run          # print, write nothing
 *   npx tsx tools/src/stale-quotes/run.ts                    # live: notes + queue + state
 *   npx tsx tools/src/stale-quotes/run.ts --doc 1516         # one estimate
 *   npx tsx tools/src/stale-quotes/run.ts --max-drafts 4     # cap this run (default 6)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient, type QBEstimate, type QBInvoice, type QBCustomer } from '@aac/api-clients/quickbooks';
import { QuoClient, type QuoMessage } from '@aac/api-clients/quo';
import { GeminiClient } from '@aac/api-clients/gemini';
import { GoogleCalendarClient, type CalendarEvent } from '@aac/api-clients/google-calendar';
import { GmailClient, type GmailMessage } from '@aac/api-clients/gmail';
import { isBotDraft } from '@aac/quoting';
import { keys, ttl } from '@aac/shared-utils/redis';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import type { QBOAuthTokens } from '@aac/shared-utils/types';

// ── config ───────────────────────────────────────────────────────────

const DATA_DIR = 'analysis/data/stale-quotes';
const STATE_PATH = `${DATA_DIR}/funnel-state.json`;
const QUEUE_PATH = `${DATA_DIR}/draft-queue.json`;
const RUNLOG_PATH = `${DATA_DIR}/followup-runlog.jsonl`;
const AWAITING_PATH = `${DATA_DIR}/awaiting-human.json`;
const PATTERNS_PATH = `${DATA_DIR}/patterns.json`; // few-shot source (optional)

const MAX_DRAFTS_PER_RUN = 6;
const QUO_THROTTLE_MS = 220; // 10 req/s hard limit — stay well under
const MAX_UNANSWERED = 3; // consecutive unanswered touches, then stop
const FINAL_AGE_OUT_DAYS = 14; // final touch unanswered this long → close flag
const RECENT_OUTBOUND_COOLOFF_H = 48; // any outbound this fresh → not this run
const OUR_EMAILS = new Set(['matt@attackacrack.com', 'attackacrackma@gmail.com']);
/** DocNumbers never touched by automation (owner holds). */
const MANUAL_HOLD_DOCS = new Set(['1523']); // Michael Fridman
const MIKE_EMAIL = 'mike@attackacrack.com';

// A/B variants (plan §4.7): stable hash of estimate ID picks the cell.
const T1_VARIANTS = [2, 3]; // days after quote
const T2_VARIANTS = [10, 14]; // days after quote (min 7d after T1 send)
const T3_GAP_DAYS = 21; // after T2 send
// Matt's capacity rule (10/21): it's about SQUARE FOOTAGE, not dollars.
// Stated footage wins — over 300 sq ft is a hold ("not even interested in
// taking on 400 sq ft"; the 450 two-car garage holds, the 285 basement
// floor releases). Stair-only work is fine up to $6k (a staircase or two);
// the ~30-staircase apartment package stays held via that cap. Dollar
// fallback only when no footage is stated anywhere on the resurf lines.
const CAPACITY_SQFT_MAX = 300;
const CAPACITY_STAIR_USD = 6000;
const CAPACITY_RESURF_LARGE_USD = 2500; // fallback when no sq ft stated

// ── types ────────────────────────────────────────────────────────────

type SuspendReason =
  | 'booked'
  | 'capacity-hold'
  | 'awaiting-human'
  | 'manual-hold'
  | 'stated-timing'
  | 'season'
  | 'no-sms-channel';

interface TouchRecord {
  tier: 'T1' | 'T2' | 'T3';
  queuedAt: string;
  draft: string;
  sentDetectedAt?: string;
  repliedWithin7d?: boolean;
}

interface EstimateState {
  estimateId: string;
  doc: string;
  customer: string;
  phone: string | null;
  firstSeenAt: string;
  seasonClass: ServiceClass;
  largeResurf: boolean;
  variant: { t1Days: number; t2Days: number };
  suspended?: { reason: SuspendReason; detail: string; at: string; until?: string };
  statedTiming?: { resumeAt: string; evidence: string; channel: string; extractedAt: string };
  /** Last inbound timestamp the intent extractor has already seen. */
  lastExtractedInboundAt?: string;
  touches: TouchRecord[];
  closedFlag?: { kind: 'age-out' | 'declined'; detail: string; at: string };
}

interface FunnelStateFile {
  updatedAt: string;
  estimates: Record<string, EstimateState>;
}

interface QueueDraft {
  doc: string;
  estimateId: string;
  customer: string;
  phone: string;
  amount: number;
  ageDays: number;
  tier: string;
  variant: string;
  draft: string;
  whyNow: string;
  queuedAt: string;
}

interface QueueFlag {
  kind: 'flip-accepted' | 'recommend-close' | 'needs-call' | 'capacity-hold';
  doc: string;
  customer: string;
  amount: number;
  detail: string;
}

interface QueueFile {
  generatedAt: string;
  bookingHorizon: string;
  toSend: QueueDraft[];
  waiting: QueueDraft[]; // queued earlier, no matching outbound detected yet
  flags: QueueFlag[];
  skipped: Array<{ doc: string; customer: string; reason: string }>;
}

/** Pending quotes where the customer's last message went unanswered — the bot
 *  stays out, but these are the hottest list in the pool for a human. Written
 *  on every full scan (dry or live) to AWAITING_PATH for the triage report. */
interface AwaitingHumanEntry {
  doc: string;
  customer: string;
  phone: string;
  amount: number;
  channel: 'sms' | 'email';
  lastInboundAt: string; // ISO day
  daysWaiting: number;
  snippet: string;
}

type ServiceClass = 'pool-deck' | 'exterior-resurf' | 'garage-interior' | 'injection';

// ── env / small utils ────────────────────────────────────────────────

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** djb2 — stable variant assignment, same spirit as followup.ts variantSlot. */
function hashCode(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function assignVariant(estimateId: string): { t1Days: number; t2Days: number } {
  const h = hashCode(`stale-quote:${estimateId}`);
  return { t1Days: T1_VARIANTS[h & 1], t2Days: T2_VARIANTS[(h >> 1) & 1] };
}

/** Levenshtein ratio for fuzzy last-name matching (Eriksen vs Erikson). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// ── service classification (plan §4.5 + Mike capacity policy) ────────

// Resurfacing classification runs on ITEM NAMES ONLY — never descriptions.
// QBO crack-repair description templates mention floors/patios/steps and
// false-positived 20+ injection quotes (Chad Brown's 3 crack injections,
// Lisa Martin's carbon fiber) into capacity-hold on the first dry run.
// Item taxonomy (from the all-time estimate pull): Concrete Resurfacing,
// Concrete Stair Resurfacing, Garage resurfacing, Pool Deck Resurfacing/
// Sealing, Epoxy Garage Coating, Sidewalk grinding/repair, Driveway Repair.
const RESURF_ITEM_RE = /resurfac|pool deck|garage coating|sidewalk|driveway|concrete leveling/i;
const FULL_SURFACE_ITEM_RE = /pool deck|garage resurfac|garage coating/i;

// Stated square footage, read from resurf line DESCRIPTIONS only (safe:
// the line is already item-name-classified as resurfacing). "approx. 450
// square feet", "225 sq ft", "1400 SF" all match.
const SQFT_RE = /([\d,]+)\s*(?:sq(?:uare)?\.?\s*(?:ft|feet|foot)|sf\b)/i;
const STAIR_ITEM_RE = /stair|step/i;

function classifyService(e: QBEstimate): { cls: ServiceClass; largeResurf: boolean; resurfTotal: number; statedSqft: number | null } {
  const lines = (e.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => {
      const d = (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } }; Amount?: number; Description?: string });
      return { item: d.SalesItemLineDetail?.ItemRef?.name ?? '', amount: d.Amount ?? 0, desc: d.Description ?? '' };
    })
    .filter((l) => l.item && !/discount|guarantee/i.test(l.item));

  const resurfLines = lines.filter((l) => RESURF_ITEM_RE.test(l.item));
  const resurfTotal = resurfLines.reduce((s, l) => s + l.amount, 0);
  const itemText = lines.map((l) => l.item).join(' ');

  let cls: ServiceClass = 'injection';
  if (/pool/i.test(itemText)) cls = 'pool-deck';
  else if (/garage/i.test(itemText) && resurfLines.length) cls = 'garage-interior';
  else if (resurfLines.length) cls = 'exterior-resurf';

  // MAX across resurf lines, not sum — resurf + epoxy on the same 225 sq ft
  // garage floor is still one 225 sq ft surface.
  const sqfts = resurfLines
    .map((l) => {
      const m = l.desc.match(SQFT_RE);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    })
    .filter((n): n is number => n !== null && n > 0);
  const statedSqft = sqfts.length ? Math.max(...sqfts) : null;
  const stairOnly = resurfLines.length > 0 && resurfLines.every((l) => STAIR_ITEM_RE.test(l.item));

  let largeResurf = false;
  if (resurfLines.length) {
    if (statedSqft !== null) largeResurf = statedSqft > CAPACITY_SQFT_MAX;
    else if (stairOnly) largeResurf = resurfTotal > CAPACITY_STAIR_USD;
    else largeResurf = resurfTotal > CAPACITY_RESURF_LARGE_USD || FULL_SURFACE_ITEM_RE.test(itemText);
  }
  return { cls, largeResurf, resurfTotal, statedSqft };
}

// ── calendar: booking check + horizon ────────────────────────────────

interface DayEvent {
  summary: string;
  location: string;
  colorId?: string;
  attendees: string[];
  days: string[]; // yyyy-mm-dd each day the event spans
  startMs: number;
}

function expandEvent(e: CalendarEvent): DayEvent {
  const startMs = new Date(e.start).getTime();
  const endMs = new Date(e.end).getTime();
  const days: string[] = [];
  // All-day events have exclusive end dates; timed events may span midnight.
  for (let t = startMs; t < Math.max(endMs, startMs + 1); t += DAY) days.push(isoDay(t));
  if (!days.length) days.push(isoDay(startMs));
  return {
    summary: e.summary ?? '',
    location: e.location ?? '',
    colorId: e.colorId,
    attendees: e.attendees ?? [],
    days,
    startMs,
  };
}

const OOO_RE = /\booo\b|out of office|vacation|away|off\b/i;

/** Is this event calendar inventory consumed? (selectBusyEvents spirit:
 *  Mike-attended + HOLDs; Matt's own meetings never block.) */
function consumesCapacity(ev: DayEvent): boolean {
  if (ev.colorId === '10' || ev.colorId === '5' || ev.colorId === '8') return true; // job / callback / HOLD
  return ev.attendees.some((a) => a.toLowerCase() === MIKE_EMAIL);
}

function computeBookingHorizon(events: DayEvent[], nowMs: number): { firstOpen: string; text: string } {
  const busy = new Set<string>();
  for (const ev of events) {
    if (OOO_RE.test(ev.summary) || consumesCapacity(ev)) {
      for (const d of ev.days) busy.add(d);
    }
  }
  for (let i = 1; i <= 150; i++) {
    const t = nowMs + i * DAY;
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue; // no Saturdays by default
    const d = isoDay(t);
    if (!busy.has(d)) {
      const weeks = Math.round(i / 7);
      const pretty = new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
      return { firstOpen: d, text: `earliest realistic opening ≈ ${pretty} (~${weeks} weeks out)` };
    }
  }
  return { firstOpen: '', text: 'calendar full for the next 150 days' };
}

/** Common first-name ↔ nickname equivalences for event corroboration
 *  (the calendar says "Bob Doherty"; QBO says "Robert Doherty"). */
const NICKNAMES: Record<string, string[]> = {
  robert: ['bob', 'rob', 'bobby'], william: ['bill', 'will', 'billy'],
  michael: ['mike'], james: ['jim', 'jimmy'], richard: ['rick', 'rich', 'dick'],
  joseph: ['joe', 'joey'], thomas: ['tom', 'tommy'], christopher: ['chris'],
  daniel: ['dan', 'danny'], matthew: ['matt'], anthony: ['tony'],
  steven: ['steve'], stephen: ['steve'], edward: ['ed', 'eddie', 'ted'],
  andrew: ['andy', 'drew'], david: ['dave'], kenneth: ['ken'],
  ronald: ['ron'], donald: ['don'], gregory: ['greg'], timothy: ['tim'],
  jonathan: ['jon'], nicholas: ['nick'], samuel: ['sam'], benjamin: ['ben'],
  lawrence: ['larry'], raymond: ['ray'], gerald: ['jerry'], john: ['jack', 'johnny'],
  elizabeth: ['liz', 'beth', 'betsy'], katherine: ['kate', 'katie', 'kathy'],
  margaret: ['maggie', 'meg', 'peggy'], patricia: ['pat', 'patty'],
  jennifer: ['jen', 'jenny'], susan: ['sue'], deborah: ['deb', 'debbie'],
  rebecca: ['becky'], kimberly: ['kim'], pamela: ['pam'], sandra: ['sandy'],
};

function firstNameMatches(first: string, words: string[]): boolean {
  if (words.includes(first)) return true;
  const aliases = NICKNAMES[first] ?? [];
  if (aliases.some((a) => words.includes(a))) return true;
  // reverse direction: QBO has the nickname, calendar has the formal name
  for (const [formal, nicks] of Object.entries(NICKNAMES)) {
    if (nicks.includes(first) && words.includes(formal)) return true;
  }
  return false;
}

/**
 * Booked-on-calendar check: fuzzy last-name match against upcoming
 * job-colored events, corroborated by first name or street number. This is
 * what caught Eriksen/"Erikson" — exact matching is insufficient (§8).
 */
function findBookedEvent(
  events: DayEvent[],
  customerName: string,
  address: string,
  nowMs: number,
): DayEvent | null {
  const tokens = customerName.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  const first = tokens[0];
  const streetNum = (address.match(/\b(\d{1,5})\b/) ?? [])[1];

  for (const ev of events) {
    if (ev.colorId !== '10' || ev.startMs < nowMs - 7 * DAY) continue; // green jobs, recent/future
    const hay = `${ev.summary} ${ev.location}`.toLowerCase();
    const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
    const lastHit = words.some((w) => w.length >= 3 && (w === last || (last.length >= 5 && similarity(w, last) >= 0.78)));
    if (!lastHit) continue;
    // Corroboration is mandatory: last-name-only matched Melanie Doherty to
    // Robert "Bob Doherty"'s job on the first dry run. First name or street
    // number must also hit, or it's not a booking.
    const firstHit = first !== last && firstNameMatches(first, words);
    const addrHit = !!streetNum && hay.includes(streetNum);
    if (firstHit || addrHit) return ev;
  }
  return null;
}

// ── thread analysis ──────────────────────────────────────────────────

interface ThreadFacts {
  messages: QuoMessage[];
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** Outbound "touches" since the last inbound (the unanswered run).
   *  Touch = outbound ≥3d post-quote after ≥72h silence (patterns.py). */
  unansweredTouches: number;
  touchesSinceQuote: number;
}

function analyzeThread(messages: QuoMessage[], quoteMs: number): ThreadFacts {
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let lastInboundAt: number | null = null;
  let lastOutboundAt: number | null = null;
  let touchesSinceQuote = 0;
  let unansweredTouches = 0;
  let prevMsgAt = 0;
  for (const m of sorted) {
    const at = new Date(m.createdAt).getTime();
    if (m.direction === 'incoming') {
      lastInboundAt = at;
      unansweredTouches = 0;
    } else {
      lastOutboundAt = at;
      const isTouch = at >= quoteMs + 3 * DAY && at - prevMsgAt >= 72 * 3_600_000;
      if (isTouch) {
        touchesSinceQuote++;
        unansweredTouches++;
      }
    }
    prevMsgAt = at;
  }
  return { messages: sorted, lastInboundAt, lastOutboundAt, unansweredTouches, touchesSinceQuote };
}

// ── Gemini: intent + stated-timing extraction ────────────────────────

interface Extraction {
  intent: 'declined' | 'went-elsewhere' | 'later' | 'engaged' | 'none';
  confidence: 'high' | 'medium' | 'low';
  /** Verbatim customer words supporting the intent (required for declines). */
  evidence: string | null;
  statedTiming: { resumeAt: string; evidence: string } | null;
  humanTopic: boolean; // price negotiation / complaint / payment chasing
}

function buildExtractionPrompt(input: {
  customer: string;
  quoteDate: string;
  items: string[];
  smsTail: string;
  emailTail: string;
  today: string;
}): string {
  return `You are analyzing a foundation-repair company's communication with a customer about an open quote.

Customer: ${input.customer}
Quote sent: ${input.quoteDate} for: ${input.items.join(', ')}
Today: ${input.today}

RECENT TEXT THREAD (newest last; "OUT" = us, "IN" = customer):
${input.smsTail || '(no text thread)'}

RECENT EMAIL FROM/TO CUSTOMER (newest last):
${input.emailTail || '(none)'}

Answer in strict JSON, nothing else:
{
  "intent": "declined" | "went-elsewhere" | "later" | "engaged" | "none",
  "confidence": "high" | "medium" | "low",
  "evidence": "<verbatim customer words supporting the intent>" | null,
  "statedTiming": { "resumeAt": "YYYY-MM-DD", "evidence": "<verbatim customer words>" } | null,
  "humanTopic": true | false
}

Rules:
- "declined"/"went-elsewhere" ONLY if the customer explicitly said so — quote their exact words in "evidence". No verbatim evidence → the intent cannot be "declined" or "went-elsewhere".
- A deferral is NOT a decline. "The buyer will fix it after closing", "we'll deal with it after we move in", "once the other project wraps" = "later" (they may well still use us) — unless they name another company or say no outright.
- "later" = customer stated a deferral ("not until spring", "after we close", "couple of weeks", "health issue, get back to you"). Convert their words to a concrete resumeAt date (be generous — if "couple of weeks", add ~2.5 weeks; if "spring", use next March 15; if "after closing" with no date, add ~6 weeks).
- "engaged" = active conversation that a bot should stay out of right now.
- "none" = nothing decision-relevant since the quote.
- humanTopic = true if there is active price negotiation, a complaint/callback, or unpaid-invoice chasing in the thread.
- statedTiming comes from CUSTOMER words only, never ours.`;
}

function parseExtraction(raw: string): Extraction | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Extraction;
    if (!j.intent) return null;
    return j;
  } catch {
    return null;
  }
}

// ── Gemini: draft generation + review ────────────────────────────────

function buildDraftPrompt(input: {
  customer: string;
  firstName: string;
  quoteDate: string;
  ageDays: number;
  items: string[];
  tier: 'T1' | 'T2' | 'T3';
  seasonClass: ServiceClass;
  horizonText: string;
  smsTail: string;
  statedTiming?: string;
  fewShots: string[];
  today: string;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You write SMS follow-ups for Matt, owner of Attack A Crack (foundation crack repair, Massachusetts). You write EXACTLY as Matt writes: friendly, direct, zero corporate filler, first person singular. One SMS (aim for 300-450 characters). Never use em dashes excessively, never sign with a name (his texts are from his known number).

HARD RULES — violating any one makes the draft unusable:
1. NEVER mention price, cost, discounts, or that pricing may have changed — in any direction.
2. NEVER invent facts: no claimed conversations, visits, or promises that are not in the thread.
3. Schedule honesty: the ONLY availability claim allowed is the booking horizon provided. Never imply we can fit them in sooner, never manufacture urgency the calendar contradicts.
4. Call it a "quote", never an "estimate".
5. No "bad news / good news" framing. State things directly.
6. If a stated timing exists, respect it — reference their stated plan, don't pressure past it.
7. Refer to the existing quote ONLY in past/present tense ("the quote I sent over"). NEVER phrase anything as a promise to send or prepare a quote ("I'll get you a quote") — the quote already exists.

Here are real follow-up texts Matt has sent (voice reference):
${input.fewShots.map((s) => `- "${s}"`).join('\n')}`;

  const tierFlavor = {
    T1: 'First follow-up. Light touch: checking they saw the quote, offer to answer questions or hop on a call. If the booking horizon is long, mention it matter-of-factly as lead-time planning info (the honest "grab a spot" angle), not fake scarcity.',
    T2: 'Second follow-up (no reply to the first). Invite questions about the approach/scope; include the honest lead-time note. Acknowledge implicitly that life gets busy — zero guilt.',
    T3: 'Final follow-up. Matt\'s proven closer: it has been a while, before I close out the quote in my system I figured I\'d reach out one more time — still interested in getting it done? A real seasonal angle is welcome if one applies (frost/freeze-thaw for cracks in winter; spring list for exterior work). Make clear no reply = he\'ll close the file, no hard feelings.',
  }[input.tier];

  const userPrompt = `Customer: ${input.customer} (address them as ${input.firstName})
Quote sent: ${input.quoteDate} (${input.ageDays} days ago) for: ${input.items.join(', ')}
Service class: ${input.seasonClass}
Booking horizon (the only availability fact you may use): ${input.horizonText}
${input.statedTiming ? `Customer's stated timing: ${input.statedTiming}` : ''}
Touch tier: ${input.tier} — ${tierFlavor}
Today: ${input.today}

RECENT THREAD (newest last; OUT = Matt, IN = customer):
${input.smsTail || '(no prior text thread beyond the quote)'}

Write the single SMS follow-up now. Output ONLY the message text, no quotes, no preamble.`;

  return { systemPrompt, userPrompt };
}

function buildReviewPrompt(draft: string, horizonText: string): string {
  return `Review this outbound SMS draft for a foundation repair company. Answer in strict JSON: {"ok": true|false, "problems": ["..."]}.

Fail it if ANY of these appear:
- mentions price/cost/discount/"prices have changed" in any form
- invents a fact, conversation, or promise
- claims availability other than: "${horizonText}" (paraphrase is fine, contradiction is not; implying a sooner slot or fake scarcity = fail)
- calls the quote an "estimate"
- longer than ~600 characters or contains multiple messages
- pressures a customer who stated a later timeline

DRAFT:
${draft}`;
}

async function generateWithRetry(gemini: GeminiClient, prompt: string, systemPrompt?: string): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await gemini.generateContent(prompt, {
        systemPrompt,
        temperature: 0,
        maxOutputTokens: 4096,
        thinkingBudget: 4096,
        timeoutMs: 120_000,
      });
    } catch (err) {
      lastErr = err as Error;
      if (attempt < 2 && /429|500|503|timeout|aborted/i.test(lastErr.message)) {
        await sleep(lastErr.message.includes('429') ? 65_000 : 5_000 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('Gemini returned nothing');
}

// ── few-shot corpus ──────────────────────────────────────────────────

function loadFewShots(): string[] {
  const fallback = [
    'Hey, just checking back in on the quote I sent over for the foundation crack. Let me know if any questions came up or if you want to grab a spot on the schedule.',
    'Hi, it has been a few months since I sent that quote over. Before I delete it out of my system I figured I would reach back one more time — still interested in getting it taken care of?',
  ];
  if (!fs.existsSync(PATTERNS_PATH)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8')) as {
      perEstimate: Array<{ touches: Array<{ text: string; replied: boolean }> }>;
    };
    const texts = data.perEstimate
      .flatMap((p) => p.touches)
      .filter((t) => t.replied && t.text.length >= 60 && t.text.length <= 350)
      .map((t) => t.text.replace(/\s+/g, ' ').trim());
    // Deduplicate near-identical bursts, keep a spread
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const t of texts) {
      const key = t.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(t);
      if (picked.length >= 12) break;
    }
    return picked.length >= 4 ? picked : fallback;
  } catch {
    return fallback;
  }
}

// ── state io ─────────────────────────────────────────────────────────

function loadState(): FunnelStateFile {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as FunnelStateFile;
  }
  return { updatedAt: '', estimates: {} };
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const docArg = argv.includes('--doc') ? argv[argv.indexOf('--doc') + 1] : undefined;
  const maxDrafts = argv.includes('--max-drafts')
    ? Number(argv[argv.indexOf('--max-drafts') + 1])
    : MAX_DRAFTS_PER_RUN;

  const now = Date.now();
  const today = isoDay(now);

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
  const gemini = new GeminiClient({
    apiKey: requireEnv('GEMINI_API_KEY'),
    textModel: 'gemini-3.6-flash',
  });
  const oauth = {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
  };
  // Calendar + Gmail are HARD gates (plan §4.3 gates 2 & 5) — no degraded mode.
  const calendar = new GoogleCalendarClient({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
    oauth,
  });
  const gmail = new GmailClient({ oauth });

  // ── pull everything once ───────────────────────────────────────────
  console.log('Pulling QBO estimates + customers + invoices…');
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
  console.log(`  ${estimates.length} estimates → ${pending.length} Pending in scope${docArg ? ` (doc ${docArg})` : ''}`);

  console.log('Pulling calendar (−21d → +150d)…');
  const rawEvents = await calendar.listEvents({
    timeMin: new Date(now - 21 * DAY).toISOString(),
    timeMax: new Date(now + 150 * DAY).toISOString(),
  });
  const events = rawEvents.map(expandEvent);
  const horizon = computeBookingHorizon(events, now);
  console.log(`  ${events.length} events; booking horizon: ${horizon.text}`);

  const state = loadState();
  const fewShots = loadFewShots();
  const queue: QueueFile = {
    generatedAt: new Date(now).toISOString(),
    bookingHorizon: horizon.text,
    toSend: [],
    waiting: [],
    flags: [],
    skipped: [],
  };
  const runlog: Array<Record<string, unknown>> = [];
  const awaitingHuman: AwaitingHumanEntry[] = [];
  let draftsThisRun = 0;

  for (const e of pending) {
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
      runlog.push({ at: new Date().toISOString(), doc, customer, outcome: 'skipped', reason });
    };

    const label = `#${doc} ${customer} $${amount.toLocaleString()} (${ageDays}d, ${svc.cls}${svc.largeResurf ? ' LARGE' : ''})`;

    // ── gate: manual hold
    if (MANUAL_HOLD_DOCS.has(doc)) {
      st.suspended = { reason: 'manual-hold', detail: 'owner hold list', at: new Date(now).toISOString() };
      skip('manual hold');
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
      await sleep(QUO_THROTTLE_MS);
      const page = await quo.listMessages({ participantE164: phone, maxResults: 100 }).catch(() => ({ data: [] as QuoMessage[] }));
      thread = analyzeThread(page.data, quoteMs);
      await sleep(QUO_THROTTLE_MS);
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
    const smsTail = thread.messages
      .slice(-12)
      .map((m) => `[${m.createdAt.slice(0, 10)} ${m.direction === 'outgoing' ? 'OUT' : 'IN'}] ${(m.text || '[media]').replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');

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

    if (lastIn && (!lastOut || lastIn > lastOut)) {
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

    const tier: 'T1' | 'T2' | 'T3' = unanswered === 0 ? 'T1' : unanswered === 1 ? 'T2' : 'T3';
    const anchor = lastOut ?? quoteMs;
    const dueMs =
      tier === 'T1'
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
    console.log(`\n── drafting ${tier} for ${label}`);
    const items = (e.Line ?? [])
      .filter((l) => l.DetailType === 'SalesItemLineDetail')
      .map((l) => (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } } }).SalesItemLineDetail?.ItemRef?.name ?? '')
      .filter((n) => n && !/discount|guarantee/i.test(n));
    const firstName = customer.split(/\s+/)[0];
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
      const reviewRaw = await generateWithRetry(gemini, buildReviewPrompt(draft, horizonText));
      const review = parseExtractionLoose<{ ok: boolean; problems?: string[] }>(reviewRaw);
      if (review?.ok) break;
      const problems = review?.problems?.join('; ') ?? 'unparseable review';
      console.log(`  ⚠ reviewer flagged: ${problems}`);
      if (pass === 1) {
        skip(`draft failed review twice: ${problems}`);
        draft = '';
        break;
      }
      draft = (await generateWithRetry(gemini, `${userPrompt}\n\nYour previous draft was rejected for: ${problems}\nPrevious draft: ${draft}\nWrite a corrected version. Output ONLY the message text.`, systemPrompt)).trim().replace(/^["']|["']$/g, '');
    }
    if (!draft) continue;

    const whyNow = `${tier} · ${unanswered} unanswered · quote ${ageDays}d old · ${svc.cls} · ${horizonText}`;
    console.log(`  ${draft}`);
    console.log(`  why: ${whyNow}`);

    const entry: QueueDraft = {
      doc, estimateId: e.Id, customer, phone: phone!, amount, ageDays,
      tier, variant: variantLabel(st), draft, whyNow, queuedAt: new Date().toISOString(),
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
          console.log('  ✓ posted Quo note');
        } else {
          console.log('  ~ no Quo contact — triage listing only');
        }
      } catch (err) {
        console.log(`  ⚠ Quo note failed: ${(err as Error).message.slice(0, 80)}`);
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
  // (dry or live) so the triage report stays current between live runs.
  if (!docArg) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    awaitingHuman.sort((a, b) => b.amount - a.amount);
    fs.writeFileSync(AWAITING_PATH, JSON.stringify({ generatedAt: new Date(now).toISOString(), entries: awaitingHuman }, null, 1));
  }
  if (!dryRun) {
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 1));
    fs.appendFileSync(RUNLOG_PATH, runlog.map((r) => JSON.stringify(r)).join('\n') + (runlog.length ? '\n' : ''));
    console.log(`\nWrote ${QUEUE_PATH} + ${STATE_PATH} (+${runlog.length} runlog rows)`);
  } else {
    console.log(`\n[dry-run] no state/queue written, no notes posted${docArg ? '' : ` (refreshed ${AWAITING_PATH})`}`);
  }

  // ── summary
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`booking horizon: ${horizon.text}`);
  console.log(`drafts to send: ${queue.toSend.length}`);
  for (const d of queue.toSend) console.log(`  [${d.tier}/${d.variant}] #${d.doc} ${d.customer} ${d.phone} $${d.amount.toLocaleString()}`);
  console.log(`still waiting (queued earlier, unsent): ${queue.waiting.length}`);
  for (const d of queue.waiting) console.log(`  [${d.tier}] #${d.doc} ${d.customer} queued ${d.queuedAt.slice(0, 10)}`);
  console.log(`flags: ${queue.flags.length}`);
  for (const f of queue.flags) console.log(`  [${f.kind}] #${f.doc} ${f.customer} $${f.amount.toLocaleString()} — ${f.detail}`);
  console.log(`awaiting your reply (customer spoke last): ${awaitingHuman.length} ($${awaitingHuman.reduce((s, a) => s + a.amount, 0).toLocaleString()})`);
  console.log(`skipped: ${queue.skipped.length}`);
  const byReason = new Map<string, number>();
  for (const s of queue.skipped) byReason.set(s.reason.split(' ')[0], (byReason.get(s.reason.split(' ')[0]) ?? 0) + 1);
  for (const [r, n] of byReason) console.log(`  ${n}× ${r}`);
}

function variantLabel(st: EstimateState): string {
  return `T1@${st.variant.t1Days}d/T2@${st.variant.t2Days}d`;
}

function parseExtractionLoose<T>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

/** Run the intent/timing extraction only when there is inbound content the
 *  extractor hasn't seen yet (cached by last-inbound timestamp in state). */
async function extractIfNeeded(input: {
  gemini: GeminiClient;
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
  if (st.lastExtractedInboundAt === lastInboundIso) return null; // already processed
  const smsTail =
    input.smsTail ??
    input.thread.messages
      .slice(-12)
      .map((m) => `[${m.createdAt.slice(0, 10)} ${m.direction === 'outgoing' ? 'OUT' : 'IN'}] ${(m.text || '[media]').replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
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
  if (extraction) st.lastExtractedInboundAt = lastInboundIso;
  return extraction;
}

async function queryAll<T>(qb: QuickBooksClient, entity: string): Promise<T[]> {
  const all: T[] = [];
  let start = 1;
  for (;;) {
    const res = await qb.query<{ QueryResponse: Record<string, T[] | undefined> }>(
      `SELECT * FROM ${entity} ORDER BY MetaData.CreateTime STARTPOSITION ${start} MAXRESULTS 100`,
    );
    const page = res.QueryResponse[entity] ?? [];
    all.push(...page);
    if (page.length < 100) break;
    start += 100;
  }
  return all;
}

main().catch((err) => {
  console.error('stale-quote followup failed:', err);
  process.exit(1);
});
