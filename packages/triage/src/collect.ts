/**
 * Triage dashboard — data collection.
 *
 * Pulls everything the gap detectors need into a single snapshot:
 *   - Google Calendar events (60d back → 60d forward)
 *   - QBO Estimates + Invoices (raw query, last 180d of updates)
 *   - Redis: field completions, scheduling queues, todos
 *   - Quo: conversations active in last 21d → messages, calls, transcripts
 *
 * Moved from tools/src/triage/collect.ts (2026-11-05); clients, env, the
 * clock, logging and the transcript/voicemail cache (TriageStore) are
 * injected. See docs/projects/triage-dashboard.md.
 */

import type { Redis } from '@upstash/redis';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient, QuoMessage, QuoCall, QuoConversation } from '@aac/api-clients/quo';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GmailClient, GmailMessage } from '@aac/api-clients/gmail';
import { isInternalPhone, quickNormalizePhone } from '@aac/shared-utils/phone';
import { keys } from '@aac/shared-utils/redis';
import { EVENT_CLASS_COLOR_IDS as COLORS } from '@aac/shared-utils/calendar';
import type { TriageStore } from './store.js';
import type { CustomerSnapshot, EmailThreadSnapshot, Snapshot, ThreadSnapshot } from './types.js';

// ── deps ─────────────────────────────────────────────────────────────

export type TriageGmail = Pick<GmailClient, 'listMessages'>;

export interface CollectDeps {
  /** Raw reads: field completions, scheduling queues, todos, worker runlogs + heartbeats. */
  redis: Pick<Redis, 'pipeline' | 'lrange' | 'zrange' | 'get'>;
  qb: Pick<QuickBooksClient, 'query'>;
  quo: Pick<QuoClient, 'listConversations' | 'listMessages' | 'listCalls' | 'getCallTranscript' | 'getCallVoicemail'>;
  calendar: Pick<GoogleCalendarClient, 'listEvents'>;
  /** Built inside the sweep's try, so a missing token or scope degrades to emailSweepError. */
  gmail: () => TriageGmail;
  store: Pick<TriageStore, 'getTranscript' | 'setTranscript' | 'getVoicemail' | 'setVoicemail'>;
  /** Our business line (QUO_PHONE_NUMBER), E.164. */
  quoPhoneNumber: string;
  now: () => number;
  log: (msg: string) => void;
}

// ── windows ──────────────────────────────────────────────────────────

const DAY = 86_400_000;
const CAL_BACK_DAYS = 60;
const CAL_FWD_DAYS = 60;
const QBO_SINCE_DAYS = 180;
const QUO_ACTIVE_DAYS = 21;
const THREAD_HISTORY_DAYS = 45;
const TRANSCRIPT_MIN_SEC = 45;
const EMAIL_ACTIVE_DAYS = 21;
const EMAIL_MAX_MESSAGES = 300;
const EMAIL_BODY_CAP = 1500;

// Both addresses are Matt — attackacrack.com is an alias into the same
// gmail mailbox, and he sends from either depending on the thread.
const OUR_EMAIL_ADDRESSES = ['matt@attackacrack.com', 'attackacrackma@gmail.com'];

// Machine senders: never customers, not worth an LLM look. Category
// filtering happens in the Gmail query; this catches transactional mail
// that lands in Primary (QBO receipts, bank alerts, Google notifications).
const AUTOMATED_SENDER_RE =
  /noreply|no-reply|donotreply|do-not-reply|notifications?@|mailer-daemon|postmaster@|@docs\.google|@calendar\.google|@payments\.google|quickbooks@|@intuit\.com|alerts?@|billing@|receipts?@/i;

// ── email helpers ────────────────────────────────────────────────────

/**
 * Strip the quoted-reply tail ("On … wrote:" + "> " lines) and cap
 * length — triage only needs the new words in each message.
 */
export function cleanEmailBody(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .{5,80} wrote:\s*$/.test(line.trim())) break;
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, EMAIL_BODY_CAP);
}

function buildEmailThreads(messages: GmailMessage[]): EmailThreadSnapshot[] {
  const ours = new Set(OUR_EMAIL_ADDRESSES);
  const byThread = new Map<string, GmailMessage[]>();
  for (const m of messages) {
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
    byThread.get(m.threadId)!.push(m);
  }

  const threads: EmailThreadSnapshot[] = [];
  for (const [threadId, msgs] of byThread) {
    msgs.sort((a, b) => a.at.localeCompare(b.at));
    const external = msgs.filter((m) => !ours.has(m.fromAddress));
    // Matt-only threads (notes to self, outbound with no reply yet) and
    // pure machine threads carry no triage signal.
    if (external.length === 0) continue;
    if (external.every((m) => AUTOMATED_SENDER_RE.test(m.fromAddress))) continue;
    const latestExternal = external[external.length - 1];
    threads.push({
      threadId,
      subject: msgs[0].subject || '(no subject)',
      counterparty: latestExternal.from,
      counterpartyAddress: latestExternal.fromAddress,
      lastActivityAt: msgs[msgs.length - 1].at,
      messages: msgs.map((m) => ({
        direction: ours.has(m.fromAddress) ? 'outgoing' : 'incoming',
        at: m.at,
        text: cleanEmailBody(m.body) || m.snippet,
        attachmentNames: m.attachmentNames,
      })),
    });
  }
  return threads;
}

// ── QBO raw query with pagination ────────────────────────────────────

async function qboFetchAll(
  client: Pick<QuickBooksClient, 'query'>,
  entity: 'Estimate' | 'Invoice' | 'Customer',
  sinceDate?: string,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  let start = 1;
  for (;;) {
    const where = sinceDate ? ` WHERE MetaData.LastUpdatedTime >= '${sinceDate}'` : '';
    const sql = `SELECT * FROM ${entity}${where} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const res = await client.query<{ QueryResponse?: Record<string, unknown> }>(sql);
    const rows = (res.QueryResponse?.[entity] as Array<Record<string, unknown>> | undefined) ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

// ── collect ──────────────────────────────────────────────────────────

export async function collect(deps: CollectDeps): Promise<Snapshot> {
  const { redis, qb, quo, calendar, store, log } = deps;
  const now = deps.now();

  const stats: Record<string, number> = {};

  // 1 ── Calendar
  const calFrom = new Date(now - CAL_BACK_DAYS * DAY).toISOString();
  const calTo = new Date(now + CAL_FWD_DAYS * DAY).toISOString();
  log(`Calendar ${calFrom.slice(0, 10)} → ${calTo.slice(0, 10)}…`);
  const events = await calendar.listEvents({ timeMin: calFrom, timeMax: calTo, maxResults: 500 });
  stats.calendarEvents = events.length;
  log(`  ${events.length} events`);

  // 2 ── QBO
  const qboSince = new Date(now - QBO_SINCE_DAYS * DAY).toISOString().slice(0, 10);
  log(`QBO estimates + invoices updated since ${qboSince}…`);
  const estimates = await qboFetchAll(qb, 'Estimate', qboSince);
  const invoices = await qboFetchAll(qb, 'Invoice', qboSince);
  stats.estimates = estimates.length;
  stats.invoices = invoices.length;
  log(`  ${estimates.length} estimates, ${invoices.length} invoices`);

  // 2b ── QBO customers (all — old customers still hold open estimates).
  // Slim projection: just enough to join estimates/invoices → Quo threads.
  log('QBO customers…');
  const rawCustomers = await qboFetchAll(qb, 'Customer');
  const customers: CustomerSnapshot[] = rawCustomers.map((c) => {
    const phoneOf = (field: unknown): string | null =>
      quickNormalizePhone((field as { FreeFormNumber?: string } | undefined)?.FreeFormNumber);
    const phones = [
      ...new Set(
        [phoneOf(c.PrimaryPhone), phoneOf(c.Mobile), phoneOf(c.AlternatePhone)].filter(
          (p): p is string => p !== null,
        ),
      ),
    ];
    const emails = String((c.PrimaryEmailAddr as { Address?: string } | undefined)?.Address ?? '')
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@'));
    const addresses = [c.BillAddr, c.ShipAddr].flatMap((a) => {
      const addr = (a ?? {}) as Record<string, unknown>;
      return ['Line1', 'Line2', 'Line3', 'Line4', 'Line5']
        .map((k) => addr[k])
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    });
    const name = String(c.DisplayName ?? '');
    const companyName = typeof c.CompanyName === 'string' ? c.CompanyName.trim() : '';
    return {
      id: String(c.Id ?? ''),
      name,
      phones,
      ...(emails.length > 0 ? { emails: [...new Set(emails)] } : {}),
      ...(companyName && companyName !== name ? { companyName } : {}),
      ...(addresses.length > 0 ? { addresses: [...new Set(addresses)] } : {}),
    };
  });
  stats.customers = customers.length;
  log(`  ${customers.length} customers (${customers.filter((c) => c.phones.length > 0).length} with phones)`);

  // 3 ── Redis: field completions for job-colored calendar events
  const jobEvents = events.filter((e) => e.colorId === COLORS.job);
  log(`Field completions for ${jobEvents.length} job events…`);
  const completions: Record<string, Record<string, unknown> | null> = {};
  for (let i = 0; i < jobEvents.length; i += 50) {
    const batch = jobEvents.slice(i, i + 50);
    const pipeline = redis.pipeline();
    for (const ev of batch) pipeline.get(keys.fieldCompletion(ev.id));
    const results = await pipeline.exec<Array<Record<string, unknown> | null>>();
    batch.forEach((ev, j) => {
      completions[ev.id] = results[j] ?? null;
    });
  }
  stats.completions = Object.values(completions).filter(Boolean).length;

  // 3b ── scheduling queues + todos
  const readDirectives = async (listKey: string): Promise<Array<Record<string, unknown>>> => {
    const ids = await redis.lrange<string>(listKey, 0, 49);
    if (ids.length === 0) return [];
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(keys.schedulingPending(id));
    const rows = await pipeline.exec<Array<Record<string, unknown> | null>>();
    return rows.filter((r): r is Record<string, unknown> => r !== null);
  };
  const [pending, review] = await Promise.all([
    readDirectives(keys.schedulingPendingList),
    readDirectives(keys.schedulingPendingReviewList),
  ]);

  const todoIds = await redis.zrange<string[]>(keys.todoList, 0, -1);
  let todos: Array<Record<string, unknown>> = [];
  if (todoIds.length > 0) {
    const pipeline = redis.pipeline();
    for (const id of todoIds) pipeline.get(keys.todo(id));
    const rows = await pipeline.exec<Array<Record<string, unknown> | null>>();
    todos = rows.filter((r): r is Record<string, unknown> => r !== null);
  }
  stats.schedulingPending = pending.length;
  stats.schedulingReview = review.length;
  stats.todos = todos.length;

  // 3c ── cloud-worker runlogs + heartbeats (message-drafts + quote drafter).
  // Upstash may hand back parsed objects or raw JSON strings depending on
  // how the entry was written — normalize both (same as harvest-edits).
  const parseLog = (rows: Array<string | Record<string, unknown>>): Array<Record<string, unknown>> =>
    rows.map((r) => (typeof r === 'string' ? (JSON.parse(r) as Record<string, unknown>) : r));
  const [mdLogRaw, qdLogRaw, scopeFlagsRaw, mdHeartbeat, qdHeartbeat, qdModeOverride] = await Promise.all([
    redis.lrange<string | Record<string, unknown>>(keys.messageDraftRunlog, 0, 199),
    redis.lrange<string | Record<string, unknown>>(keys.quoteDrafterRunlog, 0, 199),
    redis.lrange<string | Record<string, unknown>>(keys.quoteScopeFlags, 0, 99),
    redis.get<string>(keys.heartbeat('worker')),
    redis.get<string>(keys.heartbeat('quote-drafter')),
    redis.get<string>(keys.quoteDrafterMode),
  ]);
  const worker: Snapshot['worker'] = {
    messageDraftRecords: parseLog(mdLogRaw),
    quoteDrafterRunlog: parseLog(qdLogRaw),
    scopeFlags: parseLog(scopeFlagsRaw),
    messageDraftsHeartbeat: mdHeartbeat,
    quoteDrafterHeartbeat: qdHeartbeat,
    quoteDrafterModeOverride: qdModeOverride,
  };
  stats.messageDraftRecords = worker.messageDraftRecords.length;
  stats.quoteDrafterRunlog = worker.quoteDrafterRunlog.length;
  stats.scopeFlags = worker.scopeFlags.length;

  // 4 ── Quo threads
  const activeSince = now - QUO_ACTIVE_DAYS * DAY;
  const historySince = now - THREAD_HISTORY_DAYS * DAY;
  log(`Quo conversations active since ${new Date(activeSince).toISOString().slice(0, 10)}…`);

  const ownLine = deps.quoPhoneNumber;
  // Quo's list is NOT ordered by lastActivityAt (measured 2026-09-08: a
  // thread active that day sat on page 8), so never early-break on row order.
  // Bound the sweep server-side with updatedAfter and page to exhaustion.
  // Quo silently ignores broken query params (the externalIds incident), so
  // if the sweep blows past what updatedAfter should return, fail loudly
  // rather than silently miss active threads — this exact failure hid a
  // customer who thought he was booked (Ed Spooner, Sep 8).
  const MAX_CONVO_PAGES = 40;
  const activeConvos: QuoConversation[] = [];
  let totalRows = 0;
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_CONVO_PAGES) {
      throw new Error(
        `Quo conversation sweep hit ${MAX_CONVO_PAGES} pages (${totalRows} rows) — ` +
          'updatedAfter filter is likely being ignored; refusing to continue with a partial sweep',
      );
    }
    const res = await quo.listConversations({
      maxResults: 100,
      pageToken,
      updatedAfter: new Date(activeSince),
    });
    const rows = res.data ?? [];
    totalRows += rows.length;
    for (const c of rows) {
      if (new Date(c.lastActivityAt).getTime() >= activeSince) activeConvos.push(c);
    }
    if (!res.nextPageToken || rows.length === 0) break;
    pageToken = res.nextPageToken;
  }

  // One thread per external participant phone. Internal AAC lines are not
  // customers — the agent platform's comms line carries test/agent traffic
  // (e.g. the fake "Jim Smith" thread) and Ed's cell is a partner, so
  // neither may surface in triage (@aac/shared-utils INTERNAL_PHONES).
  const byPhone = new Map<string, QuoConversation>();
  for (const c of activeConvos) {
    const others = (c.participants ?? []).filter((p) => !isInternalPhone(p, ownLine));
    for (const phone of others) {
      const prev = byPhone.get(phone);
      if (!prev || c.lastActivityAt > prev.lastActivityAt) byPhone.set(phone, c);
    }
  }
  log(`  ${activeConvos.length} conversations → ${byPhone.size} distinct phones`);

  const threads: ThreadSnapshot[] = [];
  let transcriptsFetched = 0;
  let transcriptsCached = 0;
  let voicemailsFetched = 0;
  let voicemailsCached = 0;
  for (const [phone, convo] of byPhone) {
    let msgs: QuoMessage[] = [];
    let calls: QuoCall[] = [];
    try {
      [msgs, calls] = await Promise.all([
        quo.listMessages({ participantE164: phone, maxResults: 40 }).then((r) => r.data ?? []),
        quo.listCalls({ participantE164: phone, maxResults: 20 }).then((r) => r.data ?? []),
      ]);
    } catch (err) {
      log(`  ! thread ${phone}: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }

    const inWindow = <T extends { createdAt: string }>(items: T[]): T[] =>
      items.filter((it) => new Date(it.createdAt).getTime() >= historySince);

    const callRows: ThreadSnapshot['calls'] = [];
    for (const call of inWindow(calls)) {
      let hasTranscript = false;
      const eligible = call.status === 'completed' && (call.duration ?? 0) >= TRANSCRIPT_MIN_SEC;
      if (eligible) {
        if ((await store.getTranscript(call.id)) !== null) {
          hasTranscript = true;
          transcriptsCached++;
        } else {
          // QuoClient returns null on 404 and throws on any other non-ok.
          try {
            const t = await quo.getCallTranscript(call.id);
            if (t?.status === 'completed' && t.dialogue) {
              await store.setTranscript(call.id, {
                phone,
                at: call.createdAt,
                dialogue: t.dialogue as unknown as Array<Record<string, unknown>>,
              });
              hasTranscript = true;
              transcriptsFetched++;
            }
          } catch {
            // transcript is a nice-to-have; never fail the sweep on one
          }
        }
      }
      // Voicemails: ANY incoming call with 0s duration may carry one —
      // measured 2026-09-03: 30 of 31 real voicemails had status
      // 'no-answer' (only 1 was 'completed'), so status must NOT gate the
      // probe. The call object itself carries no voicemail fields —
      // GET /v1/call-voicemails/{callId} has the transcript + recording.
      // Cache both outcomes: {transcript: string} on hit, {transcript: null}
      // on 404 (call rang out — immutable), so nightly runs don't re-probe.
      // A 200 with a null transcript means "still processing": no cache
      // write, retry next run.
      let voicemail: string | undefined;
      if (call.direction === 'incoming' && (call.duration ?? 0) === 0) {
        const cachedVm = await store.getVoicemail(call.id);
        if (cachedVm !== null) {
          voicemail = cachedVm.transcript ?? undefined;
          voicemailsCached++;
        } else {
          // QuoClient returns null on 404 (call rang out) and throws on any
          // other non-ok, which caches nothing.
          try {
            const vm = await quo.getCallVoicemail(call.id);
            if (vm === null) {
              await store.setVoicemail(call.id, { phone, at: call.createdAt, transcript: null });
            } else if (vm.status === 'completed' && vm.transcript) {
              await store.setVoicemail(call.id, { phone, at: call.createdAt, transcript: vm.transcript });
              voicemail = vm.transcript;
              voicemailsFetched++;
            }
          } catch {
            // voicemail is a nice-to-have; never fail the sweep on one
          }
        }
      }

      callRows.push({
        id: call.id,
        direction: call.direction,
        status: call.status,
        at: call.createdAt,
        durationSec: call.duration ?? 0,
        hasTranscript,
        voicemail,
      });
    }

    threads.push({
      phone,
      conversationId: convo.id,
      lastActivityAt: convo.lastActivityAt,
      messages: inWindow(msgs)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((m) => ({ direction: m.direction, at: m.createdAt, text: m.text ?? '' })),
      calls: callRows.sort((a, b) => a.at.localeCompare(b.at)),
    });
  }
  stats.threads = threads.length;
  stats.transcriptsFetched = transcriptsFetched;
  stats.transcriptsCached = transcriptsCached;
  stats.voicemailsFetched = voicemailsFetched;
  stats.voicemailsCached = voicemailsCached;
  log(
    `  ${threads.length} threads, transcripts: ${transcriptsCached} cached + ${transcriptsFetched} new, voicemails: ${voicemailsCached} cached + ${voicemailsFetched} new`,
  );

  // 5 ── Gmail sweep (quote requests arrive by email too)
  // Requires gmail.readonly on the diagnostic token. Degrades to an empty
  // list + emailSweepError so a scope gap becomes a dashboard card
  // instead of a dead nightly run (analyze.ts renders it under System).
  log(`Gmail messages from last ${EMAIL_ACTIVE_DAYS}d…`);
  let emails: EmailThreadSnapshot[] = [];
  let emailSweepError: string | undefined;
  try {
    const gmail = deps.gmail();
    const messages = await gmail.listMessages({
      query: `newer_than:${EMAIL_ACTIVE_DAYS}d -in:spam -in:trash -in:chats -category:promotions -category:social -category:forums`,
      maxResults: EMAIL_MAX_MESSAGES,
    });
    emails = buildEmailThreads(messages);
    log(`  ${messages.length} messages → ${emails.length} threads with a human counterparty`);
  } catch (err) {
    emailSweepError = (err as Error).message.slice(0, 300);
    log(`  ! Gmail sweep failed: ${emailSweepError}`);
  }
  stats.emailThreads = emails.length;
  stats.emailSweepOk = emailSweepError ? 0 : 1;

  const snapshot: Snapshot = {
    generatedAt: new Date(now).toISOString(),
    windows: {
      calendarFrom: calFrom,
      calendarTo: calTo,
      qboSince,
      quoActiveSince: new Date(activeSince).toISOString(),
    },
    calendar: events,
    estimates,
    invoices,
    customers,
    completions,
    scheduling: { pending, review },
    todos,
    worker,
    threads,
    emails,
    ...(emailSweepError ? { emailSweepError } : {}),
    stats,
  };
  return snapshot;
}
