#!/usr/bin/env npx tsx
/**
 * Triage dashboard — data collection.
 *
 * Pulls everything the gap detectors need into a single local snapshot:
 *   - Google Calendar events (60d back → 60d forward)
 *   - QBO Estimates + Invoices (raw query, last 180d of updates)
 *   - Redis: field completions, scheduling queues, todos
 *   - Quo: conversations active in last 21d → messages, calls, transcripts
 *
 * Writes analysis/data/triage/snapshot.json (+ transcripts/ cache).
 * Run from repo root. Creds from .env.diagnostic. See
 * docs/projects/triage-dashboard.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient, type QuoMessage, type QuoCall, type QuoConversation } from '@aac/api-clients/quo';
import { GoogleCalendarClient, type CalendarEvent } from '@aac/api-clients/google-calendar';
import { GmailClient, type GmailMessage } from '@aac/api-clients/gmail';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { keys } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';

// ── env ──────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
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

// ── snapshot shape (consumed by analyze.ts) ──────────────────────────

export interface ThreadSnapshot {
  phone: string;
  conversationId: string;
  lastActivityAt: string;
  /** Oldest-first within the history window. */
  messages: Array<{ direction: 'incoming' | 'outgoing'; at: string; text: string }>;
  calls: Array<{
    id: string;
    direction: 'incoming' | 'outgoing';
    status: string;
    at: string;
    durationSec: number;
    hasTranscript: boolean;
    /** Voicemail transcript, when the caller left one (0s completed call). */
    voicemail?: string;
  }>;
}

export interface EmailThreadSnapshot {
  threadId: string;
  subject: string;
  /** Display name + address of the non-Matt side, from the From header. */
  counterparty: string;
  counterpartyAddress: string;
  lastActivityAt: string;
  /** Oldest-first. */
  messages: Array<{
    direction: 'incoming' | 'outgoing';
    at: string;
    /** text/plain body, quoted-reply tail stripped, capped. */
    text: string;
    attachmentNames: string[];
  }>;
}

export interface CustomerSnapshot {
  id: string;
  name: string;
  /** E.164, deduped (Primary/Mobile/Alternate). Joins QBO txns → Quo threads. */
  phones: string[];
}

export interface Snapshot {
  generatedAt: string;
  windows: {
    calendarFrom: string;
    calendarTo: string;
    qboSince: string;
    quoActiveSince: string;
  };
  calendar: CalendarEvent[];
  /** Raw QBO entities (full field set — DueDate/EmailStatus/etc. included). */
  estimates: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  customers: CustomerSnapshot[];
  completions: Record<string, Record<string, unknown> | null>;
  scheduling: {
    pending: Array<Record<string, unknown>>;
    review: Array<Record<string, unknown>>;
  };
  todos: Array<Record<string, unknown>>;
  threads: ThreadSnapshot[];
  emails: EmailThreadSnapshot[];
  /** Set when the Gmail sweep failed (e.g. token lacks gmail.readonly). */
  emailSweepError?: string;
  stats: Record<string, number>;
}

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
  client: QuickBooksClient,
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

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const now = Date.now();
  const outDir = path.resolve(process.cwd(), 'analysis/data/triage');
  const transcriptDir = path.join(outDir, 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });

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
      // Intuit invalidates the previous refresh_token on every refresh —
      // keep a local backup in case a concurrent middleware call races us.
      const backupDir = path.join(outDir, '.token-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(backupDir, `${stamp}.json`), JSON.stringify(tokens, null, 2));
    },
  });

  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });

  const calendar = new GoogleCalendarClient({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
    oauth: {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
    },
  });

  const stats: Record<string, number> = {};

  // 1 ── Calendar
  const calFrom = new Date(now - CAL_BACK_DAYS * DAY).toISOString();
  const calTo = new Date(now + CAL_FWD_DAYS * DAY).toISOString();
  console.log(`Calendar ${calFrom.slice(0, 10)} → ${calTo.slice(0, 10)}…`);
  const events = await calendar.listEvents({ timeMin: calFrom, timeMax: calTo, maxResults: 500 });
  stats.calendarEvents = events.length;
  console.log(`  ${events.length} events`);

  // 2 ── QBO
  const qboSince = new Date(now - QBO_SINCE_DAYS * DAY).toISOString().slice(0, 10);
  console.log(`QBO estimates + invoices updated since ${qboSince}…`);
  const estimates = await qboFetchAll(qb, 'Estimate', qboSince);
  const invoices = await qboFetchAll(qb, 'Invoice', qboSince);
  stats.estimates = estimates.length;
  stats.invoices = invoices.length;
  console.log(`  ${estimates.length} estimates, ${invoices.length} invoices`);

  // 2b ── QBO customers (all — old customers still hold open estimates).
  // Slim projection: just enough to join estimates/invoices → Quo threads.
  console.log('QBO customers…');
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
    return {
      id: String(c.Id ?? ''),
      name: String(c.DisplayName ?? ''),
      phones,
    };
  });
  stats.customers = customers.length;
  console.log(`  ${customers.length} customers (${customers.filter((c) => c.phones.length > 0).length} with phones)`);

  // 3 ── Redis: field completions for job-colored calendar events
  const jobEvents = events.filter((e) => e.colorId === '10');
  console.log(`Field completions for ${jobEvents.length} job events…`);
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

  // 4 ── Quo threads
  const activeSince = now - QUO_ACTIVE_DAYS * DAY;
  const historySince = now - THREAD_HISTORY_DAYS * DAY;
  console.log(`Quo conversations active since ${new Date(activeSince).toISOString().slice(0, 10)}…`);

  const ourDigits = requireEnv('QUO_PHONE_NUMBER').replace(/\D/g, '');
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

  // One thread per external participant phone.
  const byPhone = new Map<string, QuoConversation>();
  for (const c of activeConvos) {
    const others = (c.participants ?? []).filter((p) => p.replace(/\D/g, '') !== ourDigits);
    for (const phone of others) {
      const prev = byPhone.get(phone);
      if (!prev || c.lastActivityAt > prev.lastActivityAt) byPhone.set(phone, c);
    }
  }
  console.log(`  ${activeConvos.length} conversations → ${byPhone.size} distinct phones`);

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
      console.log(`  ! thread ${phone}: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }

    const inWindow = <T extends { createdAt: string }>(items: T[]): T[] =>
      items.filter((it) => new Date(it.createdAt).getTime() >= historySince);

    const callRows: ThreadSnapshot['calls'] = [];
    for (const call of inWindow(calls)) {
      let hasTranscript = false;
      const eligible = call.status === 'completed' && (call.duration ?? 0) >= TRANSCRIPT_MIN_SEC;
      if (eligible) {
        const cachePath = path.join(transcriptDir, `${call.id}.json`);
        if (fs.existsSync(cachePath)) {
          hasTranscript = true;
          transcriptsCached++;
        } else {
          // No QuoClient method for transcripts yet — direct REST, same
          // auth header. Promote into QuoClient before any app needs this.
          try {
            const r = await fetch(`https://api.openphone.com/v1/call-transcripts/${call.id}`, {
              headers: { Authorization: requireEnv('QUO_API_KEY') },
            });
            if (r.ok) {
              const t = (await r.json()) as {
                data?: { status?: string; dialogue?: Array<Record<string, unknown>> };
              };
              if (t.data?.status === 'completed' && t.data.dialogue) {
                fs.writeFileSync(
                  cachePath,
                  JSON.stringify({ phone, at: call.createdAt, dialogue: t.data.dialogue }),
                );
                hasTranscript = true;
                transcriptsFetched++;
              }
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
        const vmCache = path.join(transcriptDir, `vm-${call.id}.json`);
        if (fs.existsSync(vmCache)) {
          voicemail =
            (JSON.parse(fs.readFileSync(vmCache, 'utf8')) as { transcript: string | null })
              .transcript ?? undefined;
          voicemailsCached++;
        } else {
          try {
            const r = await fetch(`https://api.openphone.com/v1/call-voicemails/${call.id}`, {
              headers: { Authorization: requireEnv('QUO_API_KEY') },
            });
            if (r.ok) {
              const vm = (await r.json()) as {
                data?: { status?: string; transcript?: string | null };
              };
              if (vm.data?.status === 'completed' && vm.data.transcript) {
                fs.writeFileSync(
                  vmCache,
                  JSON.stringify({ phone, at: call.createdAt, transcript: vm.data.transcript }),
                );
                voicemail = vm.data.transcript;
                voicemailsFetched++;
              }
            } else if (r.status === 404) {
              fs.writeFileSync(
                vmCache,
                JSON.stringify({ phone, at: call.createdAt, transcript: null }),
              );
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
  console.log(
    `  ${threads.length} threads, transcripts: ${transcriptsCached} cached + ${transcriptsFetched} new, voicemails: ${voicemailsCached} cached + ${voicemailsFetched} new`,
  );

  // 5 ── Gmail sweep (quote requests arrive by email too)
  // Requires gmail.readonly on the diagnostic token. Degrades to an empty
  // list + emailSweepError so a scope gap becomes a dashboard card
  // instead of a dead nightly run (analyze.ts renders it under System).
  console.log(`Gmail messages from last ${EMAIL_ACTIVE_DAYS}d…`);
  let emails: EmailThreadSnapshot[] = [];
  let emailSweepError: string | undefined;
  try {
    const gmail = new GmailClient({
      oauth: {
        clientId: requireEnv('GOOGLE_CLIENT_ID'),
        clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
        refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
      },
    });
    const messages = await gmail.listMessages({
      query: `newer_than:${EMAIL_ACTIVE_DAYS}d -in:spam -in:trash -in:chats -category:promotions -category:social -category:forums`,
      maxResults: EMAIL_MAX_MESSAGES,
    });
    emails = buildEmailThreads(messages);
    console.log(`  ${messages.length} messages → ${emails.length} threads with a human counterparty`);
  } catch (err) {
    emailSweepError = (err as Error).message.slice(0, 300);
    console.log(`  ! Gmail sweep failed: ${emailSweepError}`);
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
    threads,
    emails,
    ...(emailSweepError ? { emailSweepError } : {}),
    stats,
  };

  const outPath = path.join(outDir, 'snapshot.json');
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 1));
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)}KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
