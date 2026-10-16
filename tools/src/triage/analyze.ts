#!/usr/bin/env npx tsx
/**
 * Triage dashboard — gap detectors.
 *
 * Reads analysis/data/triage/snapshot.json, runs deterministic detectors
 * (D1–D7) plus a Gemini pass over active Quo threads (L1), writes
 * analysis/data/triage/findings.json.
 *
 * Detector catalog lives in docs/projects/triage-dashboard.md. All
 * thresholds are constants below — tune after a week of real use.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';
import { HOLD_TITLE_PREFIX, STUB_TITLE_PREFIX } from '@aac/scheduling';
import { hasContinuation } from '@aac/shared-utils/multiday';
import type { EmailThreadSnapshot, Snapshot, ThreadSnapshot } from './collect.ts';

// ── thresholds ───────────────────────────────────────────────────────

const DAY = 86_400_000;
const INVOICE_LAG_HOURS = 18; // job ended this long ago with no invoice → D1
const REPLY_LAG_HOURS = 12; // inbound unanswered this long → D6
const STALE_ESTIMATE_MIN_DAYS = 3; // pending this long → appears in the list
const NUDGE_QUIET_DAYS = 3; // no Quo text/call this long → ready for a nudge
const APPROVED_UNSCHEDULED_GRACE_DAYS = 2; // spec: yellow at >48h
const ASSESSED_UNQUOTED_GRACE_DAYS = 2; // assessment done, no quote yet → D9
const STUB_IMMINENT_HOURS = 48; // stub event this close (or past) → red, D10
const OFFER_UNANSWERED_HOURS = 24; // offered slot quiet this long → D13
const UPCOMING_COMPLETE_DAYS = 7; // work events this far out must be complete → D11
// Both addresses count as "Mike is assigned" (attackacrack = new events,
// gmail = legacy; see project_mike_email_addresses).
const TECHNICIAN_EMAILS = ['mike@attackacrack.com', 'harrringtonm@gmail.com'];
const LLM_CONCURRENCY = 4;

// ── env (same pattern as collect.ts) ─────────────────────────────────

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

// ── finding shape (consumed by render.ts) ────────────────────────────

export type Section =
  | 'system'
  | 'booked_gap'
  | 'stub_review'
  | 'offer_hold'
  | 'incomplete_event'
  | 'quote_promised'
  | 'quote_gap'
  | 'deal_closer'
  | 'cash_not_invoiced'
  | 'cash_not_sent'
  | 'cash_overdue'
  | 'stale_estimate'
  | 'conversation'
  | 'solicitation';

export interface Finding {
  id: string;
  section: Section;
  severity: 'red' | 'yellow' | 'info';
  title: string;
  customer?: string;
  phone?: string;
  amount?: number;
  ageDays?: number;
  evidence?: string;
  detail?: string;
  action?: string;
  source: string;
  confidence?: 'high' | 'medium' | 'low';
  /** D5: display text for the last Quo touch ("2d ago" / "none in 21d+"). */
  lastContact?: string;
  /** Deep link to the source (Gmail thread for email findings). */
  link?: string;
}

export interface FindingsFile {
  generatedAt: string;
  snapshotAt: string;
  findings: Finding[];
  pulse: {
    arOpenTotal: number;
    arOpenCount: number;
    arOverdueTotal: number;
    notInvoicedCount: number;
    approvedUnscheduledCount: number;
    staleEstimateTotal: number;
    staleEstimateCount: number;
    quotePromisedCount: number;
    assessedUnquotedCount: number;
    stubAwaitingReviewCount: number;
    offeredHoldCount: number;
    incompleteUpcomingCount: number;
    jobsNext7: number;
    jobsNext30: number;
  };
  stats: Record<string, number>;
}

// ── name matching ────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'llc', 'inc', 'job', 'assessment', 'estimate', 'quote', 'repair',
  'crack', 'attack', 'foundation', 'basement', 'callback', 'call', 'with', 'for',
  'cont', // multi-day continuation marker in calendar titles ("Ed Spooner [cont]")
]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

interface CalEvent {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  attendees?: string[];
  start: string;
  end: string;
  colorId?: string;
}

/**
 * Surname-level equality tolerant of one-letter drift — calendar titles are
 * typed by ear and diverge from QBO ("Malderelli" vs "Maldarelli").
 */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff <= 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (skipped++ > 0) {
      return false;
    } else {
      j++;
    }
  }
  return true;
}

/** True when the event text plausibly refers to this customer. */
function eventMatchesName(ev: CalEvent, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const hayTokens = nameTokens(`${ev.summary} ${ev.location ?? ''}`);
  const hits = tokens.filter((t) => hayTokens.some((h) => tokensAlike(h, t))).length;
  // Last token is usually the surname — a surname hit alone counts.
  const last = tokens[tokens.length - 1];
  return hayTokens.some((h) => tokensAlike(h, last)) || hits >= 2;
}

// ── QBO field access (raw entities) ──────────────────────────────────

interface QboTxn {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  TxnStatus?: string;
  TotalAmt?: number;
  Balance?: number;
  DueDate?: string;
  EmailStatus?: string;
  CustomerRef?: { value?: string; name?: string };
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  PrivateNote?: string;
  BillAddr?: { Line1?: string; Line2?: string };
  ShipAddr?: { Line1?: string; Line2?: string };
}

// Generic street words carry no identity — only the street *name* joins.
const STREET_STOP = new Set([
  'street', 'avenue', 'road', 'drive', 'lane', 'court', 'place', 'circle',
  'terrace', 'unit', 'apt', 'suite', 'ave',
]);

/**
 * Address identity for matching. Third-party-payer jobs (realtor or law
 * office pays at closing) are invoiced under the payer's name, so the
 * property address is the only reliable join — but single street tokens
 * are far too weak ("Iron Hill" matched "Oak Hill" on 'hill', "S Main"
 * matched "North Main" on 'main'). Two addresses are alike only when the
 * house numbers agree AND a street-name token matches; with no number on
 * either side, every token of the shorter list must match.
 */
interface AddrKey {
  num: string | null;
  toks: string[];
}

function addrKey(line: string): AddrKey {
  const seg = line.split(',')[0];
  return {
    num: (seg.match(/\d+/) ?? [null])[0],
    toks: nameTokens(seg).filter((t) => !STREET_STOP.has(t)),
  };
}

/**
 * One key per address line (QBO free-form addresses often put the customer
 * name in Line1 and the street in Line2 — flattening them would let name
 * tokens pollute the street match).
 */
function addrKeys(txn: QboTxn): AddrKey[] {
  const keys: AddrKey[] = [];
  for (const a of [txn.BillAddr, txn.ShipAddr]) {
    if (a?.Line1) keys.push(addrKey(a.Line1));
    if (a?.Line2) keys.push(addrKey(a.Line2));
  }
  return keys.filter((k) => k.toks.length > 0);
}

function addrsAlike(a: AddrKey, b: AddrKey): boolean {
  if (a.toks.length === 0 || b.toks.length === 0) return false;
  if (!a.toks.some((t) => b.toks.some((s) => tokensAlike(s, t)))) return false;
  if (a.num && b.num) return a.num === b.num;
  const [short, long] = a.toks.length <= b.toks.length ? [a.toks, b.toks] : [b.toks, a.toks];
  return short.every((t) => long.some((s) => tokensAlike(s, t)));
}

const money = (n: unknown): number => (typeof n === 'number' ? n : 0);
const daysAgo = (iso: string | undefined, now: number): number =>
  iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : 0;

// ── Gemini thread triage (L1) ────────────────────────────────────────

interface LlmVerdict {
  needs_action: boolean;
  category: 'booked_gap' | 'quote_promised' | 'deal_closer' | 'unresolved' | 'solicitation' | 'none';
  customer_name: string | null;
  title: string;
  summary: string;
  evidence: string;
  suggested_action: string;
  urgency: 'red' | 'yellow' | 'info';
  confidence: 'high' | 'medium' | 'low';
}

function transcriptExcerpt(transcriptDir: string, callId: string, ourDigits: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(transcriptDir, `${callId}.json`), 'utf8')) as {
      dialogue?: Array<{ identifier?: string; content?: string }>;
    };
    const lines = (raw.dialogue ?? [])
      .map((d) => `${(d.identifier ?? '').replace(/\D/g, '') === ourDigits ? 'M' : 'C'}: ${d.content ?? ''}`)
      .join('\n');
    return lines.length > 3500 ? `${lines.slice(0, 1200)}\n…\n${lines.slice(-2300)}` : lines;
  } catch {
    return '';
  }
}

function threadDigest(t: ThreadSnapshot, transcriptDir: string, ourDigits: string): string {
  const parts: string[] = [];
  for (const m of t.messages.slice(-25)) {
    parts.push(`${m.direction === 'outgoing' ? 'OUT' : 'IN '} ${m.at.slice(0, 16)}: ${m.text.slice(0, 400)}`);
  }
  const withTranscripts = t.calls.filter((c) => c.hasTranscript).slice(-2);
  for (const c of t.calls) {
    parts.push(
      `CALL ${c.direction} ${c.at.slice(0, 16)} status=${c.status} ${Math.round(c.durationSec / 60)}min`,
    );
    if (c.voicemail) {
      parts.push(`VOICEMAIL left ${c.at.slice(0, 16)}: ${c.voicemail.slice(0, 500)}`);
    }
  }
  for (const c of withTranscripts) {
    const ex = transcriptExcerpt(transcriptDir, c.id, ourDigits);
    if (ex) parts.push(`TRANSCRIPT of ${c.direction} call ${c.at.slice(0, 16)}:\n${ex}`);
  }
  return parts.join('\n');
}

function sectionForCategory(cat: LlmVerdict['category']): Section {
  return cat === 'booked_gap'
    ? 'booked_gap'
    : cat === 'quote_promised'
      ? 'quote_promised'
      : cat === 'deal_closer'
        ? 'deal_closer'
        : 'conversation';
}

function emailDigest(t: EmailThreadSnapshot): string {
  const parts = [`SUBJECT: ${t.subject}`, `FROM: ${t.counterparty}`];
  for (const m of t.messages.slice(-12)) {
    const att = m.attachmentNames.length > 0 ? ` [attachments: ${m.attachmentNames.join(', ')}]` : '';
    parts.push(`${m.direction === 'outgoing' ? 'OUT' : 'IN '} ${m.at.slice(0, 16)}: ${m.text.slice(0, 600)}${att}`);
  }
  return parts.join('\n');
}

const gmailThreadLink = (threadId: string): string => `https://mail.google.com/mail/#all/${threadId}`;

function parseVerdict(raw: string): LlmVerdict | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1)) as LlmVerdict;
    if (typeof v.needs_action !== 'boolean' || !v.category) return null;
    return v;
  } catch {
    return null;
  }
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const dataDir = path.resolve(process.cwd(), 'analysis/data/triage');
  const transcriptDir = path.join(dataDir, 'transcripts');
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshot.json'), 'utf8')) as Snapshot;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const ourDigits = (process.env.QUO_PHONE_NUMBER ?? '').replace(/\D/g, '');

  const events = snapshot.calendar as unknown as CalEvent[];
  const estimates = snapshot.estimates as QboTxn[];
  const invoices = snapshot.invoices as QboTxn[];
  const findings: Finding[] = [];
  const stats: Record<string, number> = {};

  // ── D0: Gemini default-model canary ────────────────────────────────
  // Constructs GeminiClient exactly like the prod middleware does — no
  // textModel override — so a retired default model, a rejected
  // generationConfig, or a drained Prepay balance becomes a red card here
  // instead of failing silently in prod (gemini-2.5-flash retirement +
  // forced Prepay migration, Aug 2026).
  try {
    const canary = new GeminiClient({ apiKey: process.env.GEMINI_API_KEY ?? '' });
    const res = await canary.extractEntities(
      'Hi, my name is Canary Check and my email is canary@example.com.',
    );
    stats.geminiCanaryOk = res?.firstName === 'Canary' ? 1 : 0;
    if (res?.firstName !== 'Canary') {
      findings.push({
        id: 'system-gemini-canary',
        section: 'system',
        severity: 'yellow',
        title: 'Gemini canary returned an unexpected result',
        detail: `extractEntities succeeded but parsed oddly: ${JSON.stringify(res).slice(0, 200)}`,
        action: 'Check whether the gemini-flash-latest alias re-pointed to a model that behaves differently.',
        source: 'gemini-canary',
      });
    }
  } catch (err) {
    stats.geminiCanaryOk = 0;
    findings.push({
      id: 'system-gemini-canary',
      section: 'system',
      severity: 'red',
      title: 'Gemini default model FAILING — middleware classifiers likely down',
      detail: (err as Error).message.slice(0, 300),
      action:
        'Check model availability and the AI Studio Prepay balance. Middleware entity extraction and scheduling classification use this exact code path, and their failures are mostly silent.',
      source: 'gemini-canary',
    });
  }

  const invoiceById = new Map(invoices.map((inv) => [inv.Id ?? '', inv]));
  const invoiceMatches = (tokens: string[], notBefore?: number): QboTxn[] =>
    invoices.filter((inv) => {
      if (!inv.CustomerRef?.name) return false;
      const invTokens = nameTokens(inv.CustomerRef.name);
      const last = tokens[tokens.length - 1];
      if (!last || !invTokens.some((t) => tokensAlike(t, last))) return false;
      if (notBefore && inv.TxnDate && new Date(inv.TxnDate).getTime() < notBefore) return false;
      return true;
    });

  // ── D1: job done, not invoiced ────────────────────────────────────
  for (const ev of events) {
    if (ev.colorId !== '10') continue;
    // Multi-day job: only the final day is judged — earlier days have no
    // invoice or completed flow by design (docs/projects/multiday-jobs.md).
    if (hasContinuation(ev, events)) continue;
    const endMs = new Date(ev.end).getTime();
    if (endMs > now - INVOICE_LAG_HOURS * 3_600_000 || endMs < now - 60 * DAY) continue;
    const rec = snapshot.completions[ev.id] as {
      phase?: string;
      paymentStatus?: string;
      linkedInvoiceId?: string;
      cancellationReason?: string;
    } | null;
    const age = Math.floor((now - endMs) / DAY);
    const tokens = nameTokens(ev.summary);

    if (rec?.phase === 'cancelled') continue;
    if (rec?.phase === 'completed') {
      const linked = rec.linkedInvoiceId ? invoiceById.get(rec.linkedInvoiceId) : undefined;
      if (linked || rec.paymentStatus === 'cash' || rec.paymentStatus === 'check' || rec.paymentStatus === 'card') {
        continue; // invoiced or paid on the spot
      }
      // 30d lookback: a multi-day job's invoice is dated near day 1, not
      // near the last calendar day.
      const fuzzy = invoiceMatches(tokens, endMs - 30 * DAY);
      if (fuzzy.length > 0) continue;
      findings.push({
        id: `d1:${ev.id}`,
        section: 'cash_not_invoiced',
        severity: age >= 3 ? 'red' : 'yellow',
        title: `Completed, no invoice found: ${ev.summary}`,
        ageDays: age,
        detail: `Field flow completed (payment: ${rec.paymentStatus ?? 'unset'}) but no linked or matching QBO invoice. Confirm with Mike before dunning — cash/check may be unlogged.`,
        action: 'Create + send invoice in QB',
        source: 'D1',
      });
    } else {
      const fuzzy = invoiceMatches(tokens, endMs - 30 * DAY);
      // Invoiced AND paid → the money is settled; an unfinished flow record
      // is bookkeeping noise at that point, not a finding.
      if (fuzzy.some((inv) => money(inv.TotalAmt) > 0 && money(inv.Balance) === 0)) continue;
      const invoiceNote =
        fuzzy.length > 0
          ? `A matching invoice exists (#${fuzzy[0].DocNumber ?? fuzzy[0].Id}, dated ${fuzzy[0].TxnDate}) — flow tracking is the gap (or a multi-day job), money may be fine.`
          : 'No matching QBO invoice either — likely fully silent.';
      findings.push({
        id: `d1:${ev.id}`,
        section: 'cash_not_invoiced',
        severity: fuzzy.length > 0 ? 'info' : age >= 3 ? 'red' : 'yellow',
        title: `${rec ? `Field flow stuck at ${rec.phase}` : 'Field flow never started'}: ${ev.summary}`,
        ageDays: age,
        detail: `Job ended ${ev.end.slice(0, 10)}. ${invoiceNote} (The audit's root cause: silence when the flow doesn't finish.)`,
        action: rec ? 'Ask Mike to finish the field flow' : 'Verify job happened; invoice it',
        source: 'D1',
      });
    }
  }

  // ── D2/D3: invoices ───────────────────────────────────────────────
  let arOpenTotal = 0;
  let arOpenCount = 0;
  let arOverdueTotal = 0;
  for (const inv of invoices) {
    const bal = money(inv.Balance);
    if (bal <= 0) continue;
    arOpenTotal += bal;
    arOpenCount++;
    const overdueDays = inv.DueDate ? Math.floor((now - new Date(inv.DueDate).getTime()) / DAY) : 0;
    const name = inv.CustomerRef?.name ?? 'Unknown';

    // QBO only sets NeedToSend when "send later" was checked at creation;
    // an invoice created and simply never emailed sits at NotSet forever.
    // Both mean the customer likely never received it.
    //
    // Grace period: the middleware invoice-send cron emails job invoices at
    // ~7:05am two days after the green calendar job (invoice-create runs the
    // morning after). A fresh unsent invoice is therefore normal; only flag
    // once it's >= 3 days old and the automation has definitively missed it.
    if (inv.EmailStatus === 'NeedToSend' || inv.EmailStatus === 'NotSet' || !inv.EmailStatus) {
      if (daysAgo(inv.TxnDate, now) < 3) continue;
      findings.push({
        id: `d2:${inv.Id}`,
        section: 'cash_not_sent',
        severity: 'red',
        title: `Invoice #${inv.DocNumber ?? inv.Id ?? '?'} created but never emailed — ${name}`,
        customer: name,
        amount: bal,
        ageDays: daysAgo(inv.TxnDate, now),
        detail: `Created ${inv.TxnDate}, EmailStatus=${inv.EmailStatus ?? 'unknown'}, balance open.`,
        action: 'Send it from QB (or confirm it was hand-delivered)',
        source: 'D2',
      });
      continue;
    }
    if (overdueDays > 0) {
      arOverdueTotal += bal;
      findings.push({
        id: `d3:${inv.Id}`,
        section: 'cash_overdue',
        severity: overdueDays > 30 ? 'red' : 'yellow',
        title: `Overdue ${overdueDays}d — ${name} (#${inv.DocNumber ?? inv.Id})`,
        customer: name,
        amount: bal,
        ageDays: overdueDays,
        detail: `Due ${inv.DueDate}, sent status: ${inv.EmailStatus ?? 'unknown'}. Confirm no unlogged cash/check before nudging.`,
        action: overdueDays > 30 ? 'Chase payment' : 'Watch / gentle reminder',
        source: 'D3',
      });
    }
  }

  // ── D4: approved, not scheduled ───────────────────────────────────
  let approvedUnscheduled = 0;
  for (const est of estimates) {
    if (est.TxnStatus !== 'Accepted') continue;
    if ((est.LinkedTxn ?? []).some((l) => l.TxnType === 'Invoice')) continue;
    const name = est.CustomerRef?.name ?? 'Unknown';
    const tokens = nameTokens(name);
    const estAddrs = addrKeys(est);
    const acceptedMs = new Date(est.MetaData?.LastUpdatedTime ?? est.TxnDate ?? nowIso).getTime();
    if (invoiceMatches(tokens, acceptedMs - 7 * DAY).length > 0) continue; // work already billed
    // Third-party payer: invoice sits under a different name (buyer vs
    // realtor) — a same-address invoice near the acceptance also counts.
    const billedByStreet =
      estAddrs.length > 0 &&
      invoices.some(
        (inv) =>
          (!inv.TxnDate || new Date(inv.TxnDate).getTime() >= acceptedMs - 30 * DAY) &&
          addrKeys(inv).some((k) => estAddrs.some((e) => addrsAlike(k, e))),
      );
    if (billedByStreet) continue;

    const matches = events.filter(
      (ev) =>
        new Date(ev.start).getTime() >= acceptedMs - 7 * DAY &&
        (eventMatchesName(ev, tokens) ||
          estAddrs.some((e) => addrsAlike(addrKey(ev.location ?? ''), e))),
    );
    const jobMatch = matches.find((ev) => ev.colorId === '10');
    if (jobMatch) continue;

    const ageDays = Math.floor((now - acceptedMs) / DAY);
    if (ageDays < APPROVED_UNSCHEDULED_GRACE_DAYS) continue;
    approvedUnscheduled++;
    const directive = [...snapshot.scheduling.pending, ...snapshot.scheduling.review].find((d) =>
      JSON.stringify(d).includes(est.Id ?? '§none§'),
    );
    findings.push({
      id: `d4:${est.Id}`,
      section: 'booked_gap',
      severity: ageDays > 7 ? 'red' : 'yellow',
      title: `Accepted estimate not scheduled — ${name} (#${est.DocNumber ?? est.Id})`,
      customer: name,
      amount: money(est.TotalAmt),
      ageDays,
      detail: [
        `Accepted ~${new Date(acceptedMs).toISOString().slice(0, 10)}; no job (green) event matches on the calendar.`,
        matches.length > 0 ? `Non-job event matched: "${matches[0].summary}" ${matches[0].start.slice(0, 10)}.` : '',
        directive ? 'Sits in the scheduling queue awaiting action.' : 'Not in the scheduling queue either.',
      ]
        .filter(Boolean)
        .join(' '),
      action: 'Book the job',
      source: 'D4',
    });
  }

  // ── D5: stale estimates, nudge-aware ──────────────────────────────
  // Join: estimate → QBO customer phones → Quo thread last activity.
  // Threads only cover conversations active in the last 21 days, so "no
  // matching thread" means no text/call in 21+ days — definitely quiet.
  const customersById = new Map((snapshot.customers ?? []).map((c) => [c.id, c]));
  const lastContactByDigits = new Map<string, number>();
  for (const t of snapshot.threads) {
    const digits = t.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    let last = lastContactByDigits.get(digits) ?? 0;
    for (const m of t.messages) last = Math.max(last, new Date(m.at).getTime());
    for (const c of t.calls) last = Math.max(last, new Date(c.at).getTime());
    if (last > 0) lastContactByDigits.set(digits, last);
  }

  let staleTotal = 0;
  let staleCount = 0;
  for (const est of estimates) {
    if (est.TxnStatus !== 'Pending') continue;
    const age = daysAgo(est.TxnDate, now);
    if (age < STALE_ESTIMATE_MIN_DAYS) continue;
    const name = est.CustomerRef?.name ?? 'Unknown';
    const customer = customersById.get(est.CustomerRef?.value ?? '');
    const phones = customer?.phones ?? [];
    let lastContactMs = 0;
    for (const p of phones) {
      const digits = p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      lastContactMs = Math.max(lastContactMs, lastContactByDigits.get(digits) ?? 0);
    }
    const quietDays = lastContactMs > 0 ? Math.floor((now - lastContactMs) / DAY) : null;
    const nudgeReady = quietDays === null || quietDays >= NUDGE_QUIET_DAYS;
    staleTotal += money(est.TotalAmt);
    staleCount++;
    findings.push({
      id: `d5:${est.Id}`,
      section: 'stale_estimate',
      severity: nudgeReady ? 'yellow' : 'info',
      title: `${name} — #${est.DocNumber ?? est.Id}, ${age}d old`,
      customer: name,
      ...(phones[0] ? { phone: phones[0] } : {}),
      amount: money(est.TotalAmt),
      ageDays: age,
      lastContact:
        quietDays === null
          ? phones.length === 0
            ? 'no phone on file'
            : 'none in 21d+'
          : quietDays === 0
            ? 'today'
            : `${quietDays}d ago`,
      ...(nudgeReady ? { action: 'Nudge' } : {}),
      source: 'D5',
    });
  }

  // ── D9: assessment done, no quote ─────────────────────────────────
  // Purple (colorId 3) assessments are the top of the funnel; nothing
  // downstream (D4/D5 start from QBO estimates) sees one that never got a
  // quote. Match forward by name OR street to any estimate/invoice created
  // around-or-after the visit, or a green job event (same-day conversions).
  let assessedUnquoted = 0;
  for (const ev of events) {
    if (ev.colorId !== '3') continue;
    const endMs = new Date(ev.end).getTime();
    if (endMs > now - ASSESSED_UNQUOTED_GRACE_DAYS * DAY || endMs < now - 60 * DAY) continue;
    const tokens = nameTokens(ev.summary);
    if (tokens.length === 0) continue;
    const evAddr = addrKey(ev.location ?? '');
    const last = tokens[tokens.length - 1];

    // 7-day pre-window: occasionally the quote is drafted from photos
    // before the on-site visit confirms it. Judge by the LATEST touch
    // (TxnDate vs LastUpdatedTime): a photo-based quote drafted weeks
    // early and revised after the visit is still the quote for this
    // assessment (Lisa Martin #1501, 2026-10-03).
    const txnMatch = (txn: QboTxn): boolean => {
      const touchedMs = Math.max(
        txn.TxnDate ? new Date(txn.TxnDate).getTime() : 0,
        txn.MetaData?.LastUpdatedTime ? new Date(txn.MetaData.LastUpdatedTime).getTime() : 0,
      );
      if (touchedMs > 0 && touchedMs < endMs - 7 * DAY) return false;
      const custTokens = nameTokens(txn.CustomerRef?.name ?? '');
      if (custTokens.some((t) => tokensAlike(t, last))) return true;
      return addrKeys(txn).some((k) => addrsAlike(k, evAddr));
    };
    if (estimates.some(txnMatch) || invoices.some(txnMatch)) continue;

    // Name check is summary-only: location tokens collide with surnames at
    // edit distance 1 ("Morse" ≈ "White Horse Rd").
    const laterJob = events.some(
      (j) =>
        j.colorId === '10' &&
        new Date(j.start).getTime() >= endMs - DAY &&
        (nameTokens(j.summary).some((h) => tokensAlike(h, last)) ||
          addrsAlike(addrKey(j.location ?? ''), evAddr)),
    );
    if (laterJob) continue;

    // Phone via QBO customer FULL-name match — surname alone joins the
    // wrong person ("Meryl Smith" → Carol Smith, "Jeanette George" →
    // George Goodhue). No phone beats a wrong phone on a tel: link.
    const cust = (snapshot.customers ?? []).find((c) => {
      const ct = nameTokens(c.name);
      return ct.length > 0 && tokens.every((t) => ct.some((x) => tokensAlike(x, t)));
    });
    const age = Math.floor((now - endMs) / DAY);
    assessedUnquoted++;
    findings.push({
      id: `d9:${ev.id}`,
      section: 'quote_gap',
      severity: age >= 7 ? 'red' : 'yellow',
      title: `Assessment done, no quote — ${ev.summary}`,
      ...(cust?.phones[0] ? { phone: cust.phones[0] } : {}),
      ageDays: age,
      detail: `Assessed ${ev.end.slice(0, 10)}${ev.location ? ` at ${ev.location}` : ''}. No QBO estimate or invoice matches by name or street, and no job event followed.`,
      action: 'Send the quote (or dismiss if declined on site)',
      source: 'D9',
    });
  }
  stats.assessedUnquoted = assessedUnquoted;

  // ── D10: STUB events never fleshed out ────────────────────────────
  // Walk #7-lite auto-creates "STUB — {Customer}" events from chat
  // bookings (packages/scheduling/execute-stub.ts). The prefix is the
  // review marker: Matt confirms time/scope/duration and renames the
  // event; one still carrying it has not been reviewed. Red once the
  // slot is imminent (< STUB_IMMINENT_HOURS) or already past — Mike may
  // walk into an unvetted appointment, and a past stub also hides from
  // name-matching detectors (D1/D4 won't see "STUB — Jones" as "Jones").
  // Word-boundary match so surnames like "Stubbs" don't trip it.
  let stubAwaitingReview = 0;
  for (const ev of events) {
    const summary = ev.summary ?? '';
    if (!summary.startsWith(STUB_TITLE_PREFIX) && !/^stub\b/i.test(summary.trim())) continue;
    const startMs = new Date(ev.start).getTime();
    const hoursUntil = Math.round((startMs - now) / 3_600_000);
    const customer = summary.startsWith(STUB_TITLE_PREFIX)
      ? summary.slice(STUB_TITLE_PREFIX.length).trim()
      : summary.replace(/^stub\b[\s—:-]*/i, '').trim();
    const kind =
      ev.colorId === '10' ? 'job' : ev.colorId === '3' ? 'assessment' : ev.colorId === '5' ? 'callback' : 'event';
    const past = startMs <= now;
    stubAwaitingReview++;
    findings.push({
      id: `d10:${ev.id}`,
      section: 'stub_review',
      severity: past || hoursUntil < STUB_IMMINENT_HOURS ? 'red' : 'yellow',
      title: past
        ? `Stub ${kind} already happened, never fleshed out — ${customer || summary}`
        : `Stub ${kind} needs review — ${customer || summary}`,
      ...(customer ? { customer } : {}),
      ...(past ? { ageDays: Math.floor((now - startMs) / DAY) } : {}),
      detail: `${past ? 'Was' : 'Starts'} ${ev.start.slice(0, 16).replace('T', ' ')}${
        ev.location ? ` at ${ev.location}` : ''
      }. Auto-created from a chat booking; time, scope, and duration are unconfirmed${
        past ? ', and the STUB title hides it from the invoice/booking detectors' : ''
      }.`,
      action: past
        ? 'Confirm what actually happened, rename the event, and check it got invoiced'
        : `Confirm time/scope/duration, then rename to drop "${STUB_TITLE_PREFIX.trim()}"`,
      source: 'D10',
    });
  }
  stats.stubAwaitingReview = stubAwaitingReview;

  // ── D13: offered-time holds ───────────────────────────────────────
  // execute-hold places "HOLD — {Customer}" placeholders when Matt offers
  // a time by text (so the slot can't be double-offered). A hold resolves
  // one of three ways: customer confirms (stub flow deletes it), customer
  // declines (Matt deletes it), or silence — which is this detector's job:
  // >24h with no inbound reply means the customer is sitting on YOUR
  // calendar inventory. Matching is case-SENSITIVE on "HOLD" so Matt's own
  // hand-made soft blocks ("Hold in case additional ... work") don't trip it;
  // an all-caps hand-made "HOLD — Jones" is intentionally included.
  let offeredHolds = 0;
  for (const ev of events) {
    const summary = (ev.summary ?? '').trim();
    if (!summary.startsWith(HOLD_TITLE_PREFIX) && !/^HOLD\b/.test(summary)) continue;
    const customer = summary.startsWith(HOLD_TITLE_PREFIX)
      ? summary.slice(HOLD_TITLE_PREFIX.length).trim()
      : summary.replace(/^HOLD\b[\s—:-]*/, '').trim();
    const desc = ev.description ?? '';
    const offeredAtIso = /Offered-At:\s*(\S+)/.exec(desc)?.[1];
    const holdPhone = /Customer-Phone:\s*(\+?\d[\d\s().-]*)/.exec(desc)?.[1]?.trim();
    const offeredAtMs = offeredAtIso ? new Date(offeredAtIso).getTime() : NaN;
    const startMs = new Date(ev.start).getTime();
    const past = startMs <= now;

    let replied = false;
    if (holdPhone && Number.isFinite(offeredAtMs)) {
      const digits = holdPhone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      const thread = snapshot.threads.find(
        (t) => t.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') === digits,
      );
      replied =
        thread?.messages.some(
          (m) => m.direction === 'incoming' && new Date(m.at).getTime() > offeredAtMs,
        ) ?? false;
    }

    const ageH = Number.isFinite(offeredAtMs) ? Math.round((now - offeredAtMs) / 3_600_000) : null;
    const when = `${ev.start.slice(0, 16).replace('T', ' ')}${ev.location ? ` at ${ev.location}` : ''}`;

    let finding: Finding;
    if (replied) {
      finding = {
        id: `d13:${ev.id}`,
        section: 'offer_hold',
        severity: 'yellow',
        title: `Customer replied but hold still standing — ${customer || summary}`,
        detail: `${when}. They answered after the offer; if they confirmed, the stub flow should have replaced this hold — check the thread, then book it properly or delete the hold.`,
        action: 'Read the reply; convert to a real booking or release the slot',
        source: 'D13',
      };
    } else if (past) {
      finding = {
        id: `d13:${ev.id}`,
        section: 'offer_hold',
        severity: 'red',
        title: `Held slot passed with no answer — ${customer || summary}`,
        ageDays: Math.floor((now - startMs) / DAY),
        detail: `${when}. The offered time came and went without a customer reply — that inventory is gone. Delete the hold; decide whether to re-engage.`,
        action: 'Delete the hold; re-offer a new time if still worth chasing',
        source: 'D13',
      };
    } else if (ageH === null) {
      finding = {
        id: `d13:${ev.id}`,
        section: 'offer_hold',
        severity: 'yellow',
        title: `Hand-made hold — ${customer || summary}`,
        detail: `${when}. No offer metadata on this hold (hand-created?). Confirm it's still needed or release the slot.`,
        action: 'Review: still needed?',
        source: 'D13',
      };
    } else if (ageH >= OFFER_UNANSWERED_HOURS) {
      const imminent = startMs - now < STUB_IMMINENT_HOURS * 3_600_000;
      finding = {
        id: `d13:${ev.id}`,
        section: 'offer_hold',
        severity: imminent ? 'red' : 'yellow',
        title: `Offer unanswered ${ageH}h — ${customer || summary}`,
        detail: `${when}. Offered ${offeredAtIso?.slice(0, 16).replace('T', ' ')} and the customer has gone quiet${
          imminent ? ', and the slot is almost here' : ''
        }. Nudge them or release the time.`,
        action: 'Nudge the customer or delete the hold to free the slot',
        source: 'D13',
      };
    } else {
      continue; // young hold, silence is still normal
    }
    if (holdPhone) finding.phone = holdPhone;
    offeredHolds++;
    findings.push(finding);
  }
  stats.offeredHolds = offeredHolds;

  // ── D14: agreed slot, no calendar event ───────────────────────────
  // Stub-automation backstop (Vetrano incident 2026-10-12): a directive
  // carrying an agreed slot (customer confirmed, or Matt declared the
  // booking) should have materialized as a calendar event — STUB or
  // hand-made. The webhook can be killed mid-stub-creation without any
  // error landing anywhere, so this sweep reconciles the directive queue
  // against the calendar and surfaces the silent misses.
  const d14NameByDigits = new Map<string, string>();
  const d14NameByQbId = new Map<string, string>();
  for (const c of snapshot.customers ?? []) {
    d14NameByQbId.set(c.id, c.name);
    for (const p of c.phones) {
      d14NameByDigits.set(p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''), c.name);
    }
  }
  const d14Seen = new Set<string>();
  let directiveGaps = 0;
  for (const d of snapshot.scheduling.pending) {
    const intent = String(d.intent ?? '');
    const slotCommitment = String(d.slotCommitment ?? '');
    const agreed =
      intent === 'appointment_confirmed' ||
      (intent === 'manual_schedule' && slotCommitment === 'booked');
    if (!agreed) continue;
    const score = Number((d.confidence as { score?: unknown } | undefined)?.score ?? 0);
    if (score < 0.7) continue; // below the stub flow's own gate
    const slot = d.knownSlot as { startIso?: string } | null | undefined;
    const startIso = slot?.startIso;
    if (!startIso) continue;
    const startMs = new Date(startIso).getTime();
    if (!Number.isFinite(startMs)) continue;
    // Only judge slots the calendar snapshot can actually see.
    const calFrom = new Date(snapshot.windows.calendarFrom).getTime();
    const calTo = new Date(snapshot.windows.calendarTo).getTime();
    if (startMs < calFrom + DAY || startMs > calTo - DAY) continue;

    const phone = String(d.customerPhone ?? '');
    const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const dedupeKey = `${digits || String(d.pdPersonId ?? d.id)}|${startIso.slice(0, 10)}`;
    if (d14Seen.has(dedupeKey)) continue;
    d14Seen.add(dedupeKey);

    const name =
      d14NameByQbId.get(String(d.qbCustomerId ?? '')) ?? d14NameByDigits.get(digits) ?? null;
    const tokens = name ? nameTokens(name) : [];
    // Looser than eventMatchesName on purpose: suppressing a finding only
    // needs "plausibly the same person on the same day" (exact first name
    // + surname prefix), so hand-made events with drifted surname
    // spellings (Eriksen/Erickson) don't produce false red alerts.
    const looseMatch = (ev: CalEvent): boolean => {
      if (tokens.length < 2) return false;
      const hayTokens = nameTokens(`${ev.summary} ${ev.location ?? ''}`);
      const surname = tokens[tokens.length - 1];
      return (
        hayTokens.includes(tokens[0]) &&
        hayTokens.some((h) => h.slice(0, 3) === surname.slice(0, 3))
      );
    };
    // A booking that moved after the agreement still counts as booked: any
    // name-matched event on or after the directive date suppresses the
    // finding, not just events within a day of the extracted slot (Shivani
    // Lad false positive 2026-10-14 — agreed 11/09 in-thread, booked 11/11).
    const createdMs = new Date(String(d.createdAt ?? '')).getTime();
    const bookedAfterMs = Number.isFinite(createdMs) ? createdMs - DAY : startMs - 14 * DAY;
    const matched =
      tokens.length > 0 &&
      events.some((ev) => {
        if (!(eventMatchesName(ev, tokens) || looseMatch(ev))) return false;
        const evMs = new Date(ev.start).getTime();
        return Math.abs(evMs - startMs) <= DAY || evMs >= bookedAfterMs;
      });
    if (matched) continue;

    const when = startIso.slice(0, 16).replace('T', ' ');
    directiveGaps++;
    findings.push({
      id: `d14:${d.id}`,
      section: 'booked_gap',
      severity: name ? 'red' : 'yellow',
      title: name
        ? `Confirmed slot not on calendar — ${name}`
        : `Confirmed slot not on calendar — unresolved customer`,
      ...(name ? { customer: name } : {}),
      ...(phone ? { phone } : {}),
      detail: [
        `Directive ${String(d.id).slice(0, 8)} (${intent}, confidence ${score}) agreed ${when}`,
        `on ${String(d.createdAt ?? '').slice(0, 10)} — scope: ${String(d.scopeSummary ?? 'unknown')}.`,
        name
          ? 'No calendar event near that slot matches this customer; the stub likely died mid-creation (webhook timeout).'
          : 'Could not resolve a customer name from QBO to verify against the calendar — check the thread by phone.',
        'The customer thinks they are booked.',
      ].join(' '),
      action: name
        ? 'Verify the thread, then put the booking on the calendar'
        : 'Identify the customer from the thread and verify the booking exists',
      source: 'D14',
    });
  }
  stats.directiveGaps = directiveGaps;

  // ── D11: incomplete upcoming events ───────────────────────────────
  // Shivani incident 2026-10-02: Mike drove to an assessment whose event
  // had no address — he reconstructed it from the attachment, but if Matt
  // had been unreachable the visit was dead. Every work event in the next
  // week must be complete BEFORE the morning it happens: address in
  // location, a description, and (jobs/callbacks) Mike as attendee.
  // Assessments skip the attendee check — Matt runs some himself. Stubs
  // are D10's problem; [cont] days inherit day 1 by design.
  let incompleteUpcoming = 0;
  for (const ev of events) {
    const kind =
      ev.colorId === '10' ? 'Job' : ev.colorId === '3' ? 'Assessment' : ev.colorId === '5' ? 'Callback' : null;
    if (!kind) continue;
    const startMs = new Date(ev.start).getTime();
    if (startMs < now || startMs > now + UPCOMING_COMPLETE_DAYS * DAY) continue;
    const summary = (ev.summary ?? '').trim();
    if (/^stub\b/i.test(summary)) continue;
    if (/\[cont/i.test(summary)) continue;

    const problems: string[] = [];
    if (!ev.location?.trim()) problems.push('no address');
    if (!ev.description?.trim()) problems.push('no description');
    const attendees = (ev.attendees ?? []).map((a) => a.toLowerCase());
    if (
      (ev.colorId === '10' || ev.colorId === '5') &&
      !TECHNICIAN_EMAILS.some((t) => attendees.includes(t))
    ) {
      problems.push('Mike not assigned');
    }
    if (problems.length === 0) continue;

    const daysOut = Math.max(0, Math.ceil((startMs - now) / DAY));
    incompleteUpcoming++;
    findings.push({
      id: `d11:${ev.id}`,
      section: 'incomplete_event',
      severity: 'red',
      title: `${kind} ${daysOut === 0 ? 'TODAY' : `in ${daysOut}d`} — ${problems.join(', ')}: ${summary || '(untitled)'}`,
      detail: `${ev.start.slice(0, 16).replace('T', ' ')}${ev.location ? ` at ${ev.location}` : ''}. Attendees: ${
        (ev.attendees ?? []).join(', ') || 'none'
      }. Mike needs the full picture before he rolls — fix this in the calendar now.`,
      action: `Fix in calendar: add ${problems.join(' + ')}`,
      source: 'D11',
    });
  }
  stats.incompleteUpcoming = incompleteUpcoming;

  // ── D6/D7 deterministic thread flags (LLM refines below) ─────────
  const detFlags = new Map<
    string,
    { kind: 'awaiting' | 'missed_call' | 'voicemail'; evidence: string; ageH: number }
  >();
  for (const t of snapshot.threads) {
    const lastMsg = t.messages[t.messages.length - 1];
    const lastCall = t.calls[t.calls.length - 1];
    const lastMsgMs = lastMsg ? new Date(lastMsg.at).getTime() : 0;
    if (lastMsg?.direction === 'incoming' && now - lastMsgMs > REPLY_LAG_HOURS * 3_600_000) {
      detFlags.set(t.phone, {
        kind: 'awaiting',
        evidence: lastMsg.text.slice(0, 240),
        ageH: Math.round((now - lastMsgMs) / 3_600_000),
      });
    } else if (
      lastCall &&
      lastCall.direction === 'incoming' &&
      lastCall.voicemail &&
      new Date(lastCall.at).getTime() > lastMsgMs
    ) {
      // A voicemail with no reply after it outranks a plain missed call —
      // we have the caller's actual words (cancellations, approvals, asks).
      detFlags.set(t.phone, {
        kind: 'voicemail',
        evidence: lastCall.voicemail.slice(0, 240),
        ageH: Math.round((now - new Date(lastCall.at).getTime()) / 3_600_000),
      });
    } else if (
      lastCall &&
      lastCall.direction === 'incoming' &&
      (lastCall.status === 'missed' || lastCall.status === 'no-answer') &&
      new Date(lastCall.at).getTime() > lastMsgMs
    ) {
      detFlags.set(t.phone, {
        kind: 'missed_call',
        evidence: `Missed inbound call ${lastCall.at.slice(0, 16)}`,
        ageH: Math.round((now - new Date(lastCall.at).getTime()) / 3_600_000),
      });
    }
  }

  // ── L1: Gemini pass ───────────────────────────────────────────────
  // 2026-08-27: Google retired gemini-2.5-flash (the client default) for
  // this key — 404s with "update to gemini-3.6-flash".
  const gemini = new GeminiClient({
    apiKey: process.env.GEMINI_API_KEY ?? '',
    textModel: 'gemini-3.6-flash',
  });
  const calendarContext = events
    .filter((ev) => new Date(ev.end).getTime() > now - 14 * DAY)
    .map((ev) => {
      const kind = ev.colorId === '10' ? 'JOB' : ev.colorId === '3' ? 'ASSESS' : ev.colorId === '5' ? 'CALLBACK' : 'OTHER';
      return `${ev.start.slice(0, 16)} ${kind} | ${ev.summary}${ev.location ? ` | ${ev.location}` : ''}`;
    })
    .join('\n');

  // Recent estimates let the LLM tell "promised a quote and sent it" from
  // "promised a quote and dropped it" — same pattern as the calendar
  // context for booked_gap.
  const estimateContext = estimates
    .filter((e) => {
      const touched = Math.max(
        e.TxnDate ? new Date(e.TxnDate).getTime() : 0,
        e.MetaData?.LastUpdatedTime ? new Date(e.MetaData.LastUpdatedTime).getTime() : 0,
      );
      return touched > now - 60 * DAY;
    })
    .map(
      (e) =>
        `${e.TxnDate} ${e.CustomerRef?.name ?? '?'} $${money(e.TotalAmt)} ${e.TxnStatus ?? '?'}${
          e.MetaData?.LastUpdatedTime ? ` (updated ${e.MetaData.LastUpdatedTime.slice(0, 10)})` : ''
        }`,
    )
    .join('\n');

  const systemPrompt = `You triage SMS/call/email threads for Attack A Crack, a foundation-repair company in Quincy MA. Matt is the owner. In threads, OUT messages and transcript lines starting "M:" are Matt; IN and "C:" are the other party. Today is ${nowIso.slice(0, 10)}.

Below is the company Google Calendar (past 14 days + next 60 days). Event kinds: JOB = booked paid work, ASSESS = assessment visit, CALLBACK = warranty rework.

CALENDAR:
${calendarContext}

Below are the QBO estimates (quotes) created or updated in the last 60 days — this is the record of quotes actually sent.

ESTIMATES:
${estimateContext}

For the thread you are given, decide if it contains a genuinely actionable gap:
- "booked_gap": Matt told this person a visit/job is (or will be) scheduled, and NO calendar event above plausibly matches them (check names, addresses, dates carefully). This is the worst miss — a customer who thinks they're booked.
- "quote_promised": Matt told this person he would send a quote/estimate/price, and NO estimate above plausibly matches them dated or updated on-or-after the promise. This is lost deal flow — flag it even if the customer hasn't nudged. If a matching estimate exists, it is NOT quote_promised.
- "deal_closer": the customer approved a quote, asked to schedule, or asked a question that blocks a sale — and the ball is in Matt's court.
- "unresolved": the customer awaits a reply, or Matt promised a non-quote follow-up that hasn't visibly happened.
- "solicitation": the OTHER party is selling TO Matt — lead-gen or marketing services, "do you need more work / more jobs / more customers?", SEO, advertising, recruiting, bulk or robo texts. A real customer talks about THEIR property or problem; a solicitor talks about Matt's business volume. Set needs_action false.
- "none": nothing pending on our side (vendors we already work with, personal threads, or threads where Matt's last message settles everything).

Be conservative: a real gap only. If a matching calendar event exists, it is NOT a booked_gap. Respond with ONLY a JSON object:
{"needs_action": boolean, "category": "booked_gap"|"quote_promised"|"deal_closer"|"unresolved"|"solicitation"|"none", "customer_name": string|null, "title": "short label", "summary": "1-2 sentences", "evidence": "short verbatim quote from the thread", "suggested_action": "imperative, short", "urgency": "red"|"yellow"|"info", "confidence": "high"|"medium"|"low"}`;

  let llmErrors = 0;
  const askVerdict = async (label: string, userPrompt: string): Promise<LlmVerdict | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await gemini.generateContent(userPrompt, {
          systemPrompt,
          temperature: 0,
          // 3.6-flash counts internal reasoning against this budget —
          // 1024 truncated ~20% of responses mid-JSON.
          maxOutputTokens: 8192,
        });
        const v = parseVerdict(raw);
        if (!v) {
          llmErrors++;
          console.log(`  ! parse failure ${label}: ${raw.slice(0, 160).replace(/\n/g, ' ')}`);
        }
        return v;
      } catch (err) {
        const msg = (err as Error).message;
        // Rate limits / transient 5xx: back off and retry.
        if (attempt < 2 && /429|500|503|timeout|aborted/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
          continue;
        }
        llmErrors++;
        console.log(`  ! LLM error ${label}: ${msg.slice(0, 200).replace(/\n/g, ' ')}`);
        return null;
      }
    }
    return null;
  };

  const candidates = snapshot.threads.filter((t) => t.messages.length > 0 || t.calls.length > 0);
  stats.llmThreads = candidates.length;
  const verdicts = new Map<string, LlmVerdict>();

  for (let i = 0; i < candidates.length; i += LLM_CONCURRENCY) {
    const batch = candidates.slice(i, i + LLM_CONCURRENCY);
    await Promise.all(
      batch.map(async (t) => {
        const digest = threadDigest(t, transcriptDir, ourDigits);
        if (!digest.trim()) return;
        const v = await askVerdict(t.phone, `THREAD with ${t.phone}:\n${digest}`);
        if (v) verdicts.set(t.phone, v);
      }),
    );
    if (i % 20 === 0) console.log(`  LLM ${Math.min(i + LLM_CONCURRENCY, candidates.length)}/${candidates.length}`);
  }

  for (const t of snapshot.threads) {
    const v = verdicts.get(t.phone);
    const det = detFlags.get(t.phone);
    if (v?.category === 'solicitation') {
      // Someone selling TO Matt ("need more jobs?"). Never a priority, but
      // stays visible as info with its evidence per [[ai-quality-gates]] —
      // a misread real customer should be spottable at a glance.
      findings.push({
        id: `l1:${t.phone}`,
        section: 'solicitation',
        severity: 'info',
        title: `Likely solicitation — ${v.title || t.phone}`,
        customer: v.customer_name ?? undefined,
        phone: t.phone,
        evidence: v.evidence,
        detail: v.summary,
        action: 'Ignore (vendor/marketing). Dismiss by phone if they persist.',
        source: 'L1',
        confidence: v.confidence,
      });
    } else if (v?.needs_action && v.category !== 'none') {
      const section = sectionForCategory(v.category);
      findings.push({
        id: `l1:${t.phone}`,
        section,
        severity: v.urgency ?? 'yellow',
        title: v.title || `Thread with ${t.phone}`,
        customer: v.customer_name ?? undefined,
        phone: t.phone,
        evidence: v.evidence,
        detail: v.summary,
        action: v.suggested_action,
        source: 'L1',
        confidence: v.confidence,
      });
    } else if (det && (!v || det.kind === 'voicemail')) {
      // LLM failed for this thread — keep the deterministic flag. For
      // voicemails, keep it even when the LLM says "no action": an
      // unanswered voicemail is always worth a card (the LLM refines the
      // finding above when it agrees, but must not erase the signal —
      // learned 2026-09-03 when it judged a warranty-transfer inquiry
      // from a future home buyer as not actionable).
      findings.push({
        id: `d6:${t.phone}`,
        section: 'conversation',
        severity: det.kind === 'voicemail' ? 'yellow' : 'info',
        title:
          det.kind === 'awaiting'
            ? `Awaiting reply ${det.ageH}h — ${t.phone}`
            : det.kind === 'voicemail'
              ? `Voicemail needs action ${det.ageH}h — ${t.phone}`
              : `Missed call, no follow-up — ${t.phone}`,
        phone: t.phone,
        evidence: det.evidence,
        source: det.kind === 'awaiting' ? 'D6' : det.kind === 'voicemail' ? 'D8' : 'D7',
        confidence: det.kind === 'voicemail' ? 'medium' : 'low',
      });
    }
  }

  // ── L2 + D12: email threads ───────────────────────────────────────
  // Same triage brain, different channel — quote requests increasingly
  // arrive by email and were invisible to the dashboard (added 2026-10-07).
  // L2 = LLM verdict on an email thread; D12 = deterministic unanswered-
  // inbound fallback when the LLM gave nothing (mirrors D6 for SMS).
  const emailThreads = snapshot.emails ?? [];
  stats.llmEmailThreads = emailThreads.length;
  if (snapshot.emailSweepError) {
    findings.push({
      id: 'system-email-sweep',
      section: 'system',
      severity: 'yellow',
      title: 'Email sweep failing — email triage is blind',
      detail: snapshot.emailSweepError,
      action:
        'If this mentions scopes or permissions, the Google token lacks gmail.readonly: run npx tsx tools/src/scratch/reauth-google.ts and paste the new GOOGLE_REFRESH_TOKEN into .env.diagnostic.',
      source: 'system',
    });
  }

  const emailVerdicts = new Map<string, LlmVerdict>();
  for (let i = 0; i < emailThreads.length; i += LLM_CONCURRENCY) {
    const batch = emailThreads.slice(i, i + LLM_CONCURRENCY);
    await Promise.all(
      batch.map(async (t) => {
        const v = await askVerdict(`email:${t.threadId}`, `EMAIL THREAD:\n${emailDigest(t)}`);
        if (v) emailVerdicts.set(t.threadId, v);
      }),
    );
  }

  for (const t of emailThreads) {
    const v = emailVerdicts.get(t.threadId);
    const displayName = t.counterparty.replace(/<[^>]*>/, '').trim() || t.counterpartyAddress;
    const last = t.messages[t.messages.length - 1];
    if (v?.category === 'solicitation') {
      findings.push({
        id: `l2:${t.threadId}`,
        section: 'solicitation',
        severity: 'info',
        title: `Likely solicitation (email) — ${v.title || t.subject}`,
        customer: v.customer_name ?? displayName,
        evidence: v.evidence,
        detail: v.summary,
        action: 'Ignore (vendor/marketing).',
        source: 'L2',
        confidence: v.confidence,
        link: gmailThreadLink(t.threadId),
      });
    } else if (v?.needs_action && v.category !== 'none') {
      findings.push({
        id: `l2:${t.threadId}`,
        section: sectionForCategory(v.category),
        severity: v.urgency ?? 'yellow',
        title: `✉ ${v.title || t.subject}`,
        customer: v.customer_name ?? displayName,
        evidence: v.evidence,
        detail: v.summary,
        action: v.suggested_action,
        source: 'L2',
        confidence: v.confidence,
        link: gmailThreadLink(t.threadId),
      });
    } else if (!v && last.direction === 'incoming') {
      const ageH = Math.round((now - new Date(last.at).getTime()) / 3_600_000);
      if (ageH >= REPLY_LAG_HOURS) {
        findings.push({
          id: `d12:${t.threadId}`,
          section: 'conversation',
          severity: 'info',
          title: `Email awaiting reply ${ageH}h — ${t.subject}`,
          customer: displayName,
          evidence: last.text.slice(0, 240),
          source: 'D12',
          confidence: 'low',
          link: gmailThreadLink(t.threadId),
        });
      }
    }
  }
  stats.llmErrors = llmErrors;

  // ── booked-customer downgrade ─────────────────────────────────────
  // A customer with a job (green) event on the calendar today-or-later is
  // closed business, not an open lead — QBO TxnStatus often stays Pending
  // after Matt books the job, and the LLM detectors can't see the calendar
  // (Karim Awad / Shivani false alarms, 2026-10-16). Downgrade rather than
  // drop: a booked customer can still have a real question in-thread.
  const upcomingJobs = events.filter(
    (ev) => ev.colorId === '10' && new Date(ev.start).getTime() >= now - DAY,
  );
  const BOOKABLE_SECTIONS: Section[] = [
    'stale_estimate',
    'conversation',
    'deal_closer',
    'quote_promised',
    'quote_gap',
  ];
  for (const f of findings) {
    if (f.severity === 'info' || !f.customer) continue;
    if (!BOOKABLE_SECTIONS.includes(f.section)) continue;
    const tokens = nameTokens(f.customer);
    if (tokens.length < 2) continue; // first-name-only matches are too loose
    const booked = upcomingJobs.find((ev) => eventMatchesName(ev, tokens));
    if (booked) {
      f.severity = 'info';
      f.detail = `[Already booked: "${booked.summary}" ${booked.start.slice(0, 10)}] ${f.detail ?? ''}`.trim();
    }
  }

  // ── dismissals ────────────────────────────────────────────────────
  // analysis/data/triage/dismissals.json: owner-curated suppressions for
  // findings resolved outside the system or explicitly not worth chasing
  // (e.g. hostile customer, investigated-and-declined). Each entry:
  //   { match: string, sections?: Section[], reason: string, addedAt: string,
  //     until?: string }
  // `match` is checked case-insensitively against customer, title, and phone.
  // `until` (YYYY-MM-DD) makes the rule a temporary hold — it stops
  // suppressing once that date passes (e.g. invoice waiting on a callback).
  const dismissalsPath = path.join(dataDir, 'dismissals.json');
  if (fs.existsSync(dismissalsPath)) {
    const rules = JSON.parse(fs.readFileSync(dismissalsPath, 'utf8')) as Array<{
      match: string;
      sections?: Section[];
      reason?: string;
      until?: string;
    }>;
    const today = new Date().toISOString().slice(0, 10);
    const kept = findings.filter(
      (f) =>
        !rules.some(
          (r) =>
            (!r.until || r.until >= today) &&
            (!r.sections || r.sections.includes(f.section)) &&
            [f.customer, f.title, f.phone].some(
              (v) => v && v.toLowerCase().includes(r.match.toLowerCase())
            )
        )
    );
    stats.dismissed = findings.length - kept.length;
    findings.length = 0;
    findings.push(...kept);
  }

  // ── pulse + output ────────────────────────────────────────────────
  const jobsBetween = (fromMs: number, toMs: number): number =>
    events.filter((ev) => ev.colorId === '10' && new Date(ev.start).getTime() >= fromMs && new Date(ev.start).getTime() < toMs).length;

  const out: FindingsFile = {
    generatedAt: nowIso,
    snapshotAt: snapshot.generatedAt,
    findings,
    pulse: {
      arOpenTotal: Math.round(arOpenTotal),
      arOpenCount,
      arOverdueTotal: Math.round(arOverdueTotal),
      notInvoicedCount: findings.filter((f) => f.section === 'cash_not_invoiced' && f.severity !== 'info').length,
      // Recomputed from the (post-dismissal) findings list, not the raw
      // detector counters, so suppressed items don't inflate the pulse.
      approvedUnscheduledCount: findings.filter((f) => f.source === 'D4').length,
      staleEstimateTotal: Math.round(
        findings.filter((f) => f.source === 'D5').reduce((a, f) => a + (f.amount ?? 0), 0)
      ),
      staleEstimateCount: findings.filter((f) => f.source === 'D5').length,
      quotePromisedCount: findings.filter((f) => f.section === 'quote_promised').length,
      assessedUnquotedCount: findings.filter((f) => f.source === 'D9').length,
      stubAwaitingReviewCount: findings.filter((f) => f.source === 'D10').length,
      offeredHoldCount: findings.filter((f) => f.source === 'D13').length,
      incompleteUpcomingCount: findings.filter((f) => f.source === 'D11').length,
      jobsNext7: jobsBetween(now, now + 7 * DAY),
      jobsNext30: jobsBetween(now, now + 30 * DAY),
    },
    stats: { ...snapshot.stats, ...stats, findings: findings.length },
  };

  const outPath = path.join(dataDir, 'findings.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`Wrote ${outPath} — ${findings.length} findings (${llmErrors} LLM errors)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
