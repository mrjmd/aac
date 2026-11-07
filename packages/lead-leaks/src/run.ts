import type { GeminiClient } from '@aac/api-clients/gemini';
import type { GoogleCalendarClient, CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QuickBooksClient, QBCustomer } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoClient, QuoMessage } from '@aac/api-clients/quo';
import { customerNameMatches, extractPhonesFromDescription, summaryMatchesCustomer } from '@aac/customers';
import { EVENT_CLASS_COLOR_IDS } from '@aac/shared-utils/calendar';
import { isInternalPhone, quickNormalizePhone } from '@aac/shared-utils/phone';
import { isLeak, parseVerdict, SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { callsToTranscribe, renderThread, threadFacts } from './thread.js';
import type { CachedVerdict, LeadLeakSnapshot, LeakRow, QuietRow, ThreadFacts, Verdict } from './types.js';
import { leakValue } from './value.js';

export const WINDOW_DAYS = 90;
/** Parallel thread reads (Quo + Gemini). */
const CONCURRENCY = 5;
const DAY = 86_400_000;
/** A bare missed call stays a lead this long; after that, with no voicemail or text, it's phone tag (mostly solicitors). */
export const MISSED_CALL_DAYS = 7;

/** The Upstash calls a run uses. */
export interface LeadLeakRedis {
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
  set(key: string, value: string): Promise<unknown>;
}

export interface LeadLeakDeps {
  redis: LeadLeakRedis;
  quo: Pick<QuoClient, 'listConversations' | 'listMessages' | 'listCalls' | 'getCallTranscript' | 'getCallVoicemail'>;
  qb: Pick<QuickBooksClient, 'listAllCustomers' | 'listEstimatesUpdatedSince'>;
  calendar: Pick<GoogleCalendarClient, 'listEvents'>;
  gemini: Pick<GeminiClient, 'generateJson'>;
  ownLine: string;
  keys: { snapshot: string; verdicts: string };
}

function customerPhones(c: QBCustomer): string[] {
  return [c.PrimaryPhone, c.Mobile, c.AlternatePhone]
    .map((f) => quickNormalizePhone(f?.FreeFormNumber))
    .filter((p): p is string => !!p);
}

/**
 * Pure: phones settled without reading the thread. A QBO estimate dated in
 * the window means quoted; a job or callback on the calendar means booked.
 * A past assessment with neither is the stage C hint.
 */
export function settledPhones(input: {
  customers: QBCustomer[];
  estimates: Array<{ CustomerRef: { value: string }; TxnDate?: string }>;
  events: CalendarEvent[];
  since: string;
  now: Date;
}): { quoted: Set<string>; booked: Set<string>; assessedOn: Map<string, string>; settledName: (name: string | null) => boolean } {
  const quotedCustomers = new Set(input.estimates.filter((e) => (e.TxnDate ?? '') >= input.since.slice(0, 10)).map((e) => e.CustomerRef.value));
  const quoted = new Set<string>();
  const quotedNames: string[] = [];
  for (const c of input.customers) {
    if (!c.Id || !quotedCustomers.has(c.Id)) continue;
    for (const p of customerPhones(c)) quoted.add(p);
    quotedNames.push(c.DisplayName, ...(c.CompanyName ? [c.CompanyName] : []));
  }
  const booked = new Set<string>();
  const bookedTitles: string[] = [];
  const assessedOn = new Map<string, string>();
  for (const e of input.events) {
    const isAssessment = e.colorId === EVENT_CLASS_COLOR_IDS.assessment;
    const past = Date.parse(e.start) < input.now.getTime();
    const isBooking = e.colorId === EVENT_CLASS_COLOR_IDS.job || e.colorId === EVENT_CLASS_COLOR_IDS.callback || (isAssessment && !past);
    if (isBooking) bookedTitles.push(e.summary);
    for (const p of extractPhonesFromDescription(`${e.description ?? ''} ${e.location ?? ''}`)) {
      if (isAssessment && past) assessedOn.set(p, e.start.slice(0, 10));
      else if (isBooking) booked.add(p);
    }
  }
  // QBO and calendar names drift from Quo numbers (a second phone, a realtor's line): a full name the
  // model read from the thread that matches a quoted customer or a booked event settles it too.
  const settledName = (name: string | null) =>
    !!name &&
    (quotedNames.some((n) => customerNameMatches(n, name)) || bookedTitles.some((t) => summaryMatchesCustomer(t, name)));
  return { quoted, booked, assessedOn, settledName };
}

/** Run `fn` over `items`, `n` at a time, stopping new work past the deadline. */
async function pool<T>(items: T[], n: number, deadlineMs: number, fn: (t: T) => Promise<void>): Promise<boolean> {
  let i = 0;
  let cut = false;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        if (Date.now() > deadlineMs) {
          cut = true;
          return;
        }
        await fn(items[i++]!);
      }
    }),
  );
  return cut;
}

async function readThread(
  deps: LeadLeakDeps,
  phone: string,
): Promise<{ messages: QuoMessage[]; calls: QuoCall[]; transcripts: Record<string, string[]>; voicemails: Record<string, string> }> {
  const [m, c] = await Promise.all([
    deps.quo.listMessages({ participantE164: phone, maxResults: 100 }),
    deps.quo.listCalls({ participantE164: phone, maxResults: 50 }),
  ]);
  const messages = m.data ?? [];
  const calls = c.data ?? [];
  const transcripts: Record<string, string[]> = {};
  const voicemails: Record<string, string> = {};
  await Promise.all([
    ...callsToTranscribe(calls).map(async (call) => {
      const t = await deps.quo.getCallTranscript(call.id).catch(() => null);
      if (t?.dialogue?.length) {
        transcripts[call.id] = t.dialogue.slice(0, 80).map((d) => `${d.identifier === phone ? 'THEM' : 'US'}: ${d.content}`);
      }
    }),
    ...calls
      .filter((x) => x.direction === 'incoming' && x.voicemail)
      .slice(-3)
      .map(async (call) => {
        const v = await deps.quo.getCallVoicemail(call.id).catch(() => null);
        if (v?.transcript) voicemails[call.id] = v.transcript;
      }),
  ]);
  return { messages, calls, transcripts, voicemails };
}

function factsLine(f: ThreadFacts): string {
  return `First contact ${f.firstAt.slice(0, 10)}, last activity ${f.lastAt.slice(0, 10)} (${f.lastWho === 'them' ? 'them' : 'us'} last), ${f.inboundTexts} texts from them, ${f.photos} photos.`;
}

/**
 * Nightly: every 1:1 thread on the business line with activity in the last
 * 90 days, settled ones (quoted, booked) dropped without a read, the rest
 * read by the model once per thread movement (verdict cache). Saves the
 * snapshot the command center's Sales page shows. Reads only; sends nothing.
 */
export async function runLeadLeaks(deps: LeadLeakDeps, opts: { now: Date; deadlineMs: number }): Promise<LeadLeakSnapshot> {
  const since = new Date(opts.now.getTime() - WINDOW_DAYS * DAY);
  const gaps: string[] = [];

  const convos = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const res = await deps.quo.listConversations({ maxResults: 100, pageToken, updatedAfter: since });
    for (const c of res.data ?? []) {
      const external = c.participants.filter((p) => !isInternalPhone(p, deps.ownLine));
      if (external.length !== 1 || c.participants.length > 2) continue;
      const phone = quickNormalizePhone(external[0]);
      if (phone && !isInternalPhone(phone, deps.ownLine) && c.lastActivityAt > (convos.get(phone) ?? '')) convos.set(phone, c.lastActivityAt);
    }
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);

  const [customers, estimates, events] = await Promise.all([
    deps.qb.listAllCustomers({ includeInactive: true }),
    deps.qb.listEstimatesUpdatedSince(new Date(since.getTime() - 30 * DAY).toISOString()),
    deps.calendar.listEvents({ timeMin: since.toISOString(), timeMax: new Date(opts.now.getTime() + 90 * DAY).toISOString() }),
  ]);
  const { quoted, booked, assessedOn, settledName } = settledPhones({ customers, estimates, events, since: since.toISOString(), now: opts.now });

  const cache = (await deps.redis.hgetall<Record<string, CachedVerdict>>(deps.keys.verdicts)) ?? {};
  const rows: LeakRow[] = [];
  const quiet: QuietRow[] = [];
  const counts: LeadLeakSnapshot['counts'] = {
    quoted_or_booked: 0,
    solicitation: 0,
    existing_customer: 0,
    declined: 0,
    deferred: 0,
    ct: 0,
    phone_tag: 0,
    other: 0,
  };
  let threads = 0;
  let llmCalls = 0;
  let failed = 0;

  const todo = [...convos.entries()].filter(([phone]) => {
    if (quoted.has(phone) || booked.has(phone)) {
      counts.quoted_or_booked++;
      return false;
    }
    return true;
  });

  const tally = (phone: string, lastActivityAt: string, facts: ThreadFacts | null, verdict: Verdict | null) => {
    // Nothing from them inside the window: not a lead in this window.
    if (!facts?.lastInboundAt || facts.lastInboundAt < since.toISOString() || !verdict) return;
    threads++;
    if (facts.missedOnly && verdict.status === 'no_reply' && opts.now.getTime() - Date.parse(facts.lastAt) > MISSED_CALL_DAYS * DAY) {
      counts.phone_tag++;
    } else if (isLeak(verdict.status) && settledName(verdict.name)) {
      counts.quoted_or_booked++;
    } else if (isLeak(verdict.status)) {
      const { value, basis } = leakValue(verdict.status, verdict.scope, facts.missedOnly);
      rows.push({
        phone,
        name: verdict.name,
        stage: verdict.status,
        firstAt: facts.firstAt,
        lastAt: facts.lastAt,
        lastWho: facts.lastWho,
        lastText: facts.lastText,
        askedFor: verdict.askedFor,
        whyStuck: verdict.whyStuck,
        photos: facts.photos,
        value,
        valueBasis: basis,
        lastActivityAt,
      });
    } else if (verdict.status === 'quiet') {
      quiet.push({ phone, name: verdict.name, askedFor: verdict.askedFor, lastAt: facts.lastAt });
    } else if (verdict.status === 'quoted_or_booked') {
      counts.quoted_or_booked++;
    } else {
      counts[verdict.exclude ?? 'other']++;
    }
  };

  // Threads that haven't moved since the last read cost nothing: tally them first.
  const fresh: Array<[string, string]> = [];
  for (const [phone, lastActivityAt] of todo) {
    const hit = cache[phone];
    const assessed = assessedOn.get(phone) ?? null;
    if (hit && hit.lastActivityAt === lastActivityAt && (hit.assessed ?? null) === assessed) tally(phone, lastActivityAt, hit.facts, hit.verdict);
    else fresh.push([phone, lastActivityAt]);
  }

  const partial = await pool(fresh, CONCURRENCY, opts.deadlineMs, async ([phone, lastActivityAt]) => {
    try {
      const assessed = assessedOn.get(phone) ?? null;
      const t = await readThread(deps, phone);
      const facts = threadFacts(t.messages, t.calls);
      let verdict: Verdict | null = null;
      if (!facts?.lastInboundAt || facts.lastInboundAt < since.toISOString()) {
        verdict = null;
      } else if (facts.missedOnly && !assessed) {
        // Missed calls and nothing else: no model read needed.
        verdict = { status: 'no_reply', exclude: null, name: null, askedFor: 'Unknown, missed call', whyStuck: 'Missed call, no voicemail, no callback from us.', scope: 'unknown' };
      } else {
        const raw = await deps.gemini.generateJson<unknown>(
          userPrompt({
            phone,
            facts: factsLine(facts),
            thread: renderThread(t.messages, t.calls, t.transcripts, t.voicemails),
            calendarNote: assessed ? `assessment on the calendar ${assessed}, no quote in QuickBooks since` : null,
          }),
          { systemPrompt: SYSTEM_PROMPT, temperature: 0, maxOutputTokens: 4096, timeoutMs: 90_000, retries: 2 },
        );
        llmCalls++;
        verdict = parseVerdict(raw);
      }
      const entry: CachedVerdict = { lastActivityAt, assessed, facts, verdict, at: opts.now.toISOString() };
      await deps.redis.hset(deps.keys.verdicts, { [phone]: entry });
      tally(phone, lastActivityAt, facts, verdict);
    } catch (err) {
      failed++;
      if (failed <= 3) gaps.push(`${phone}: ${(err as Error).message.slice(0, 120)}`);
    }
  });
  if (failed > 3) gaps.push(`${failed - 3} more threads failed to read`);
  if (partial) gaps.push('Ran out of time; the rest are read tomorrow');

  const stageOrder = { no_reply: 0, no_quote: 1, assessed: 2 } as const;
  rows.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || b.lastAt.localeCompare(a.lastAt));
  quiet.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const snapshot: LeadLeakSnapshot = {
    builtAt: opts.now.toISOString(),
    windowDays: WINDOW_DAYS,
    rows,
    quiet,
    counts,
    threads,
    llmCalls,
    partial,
    gaps,
  };
  await deps.redis.set(deps.keys.snapshot, JSON.stringify(snapshot));
  return snapshot;
}
