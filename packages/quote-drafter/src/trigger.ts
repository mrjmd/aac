/**
 * Trigger loop (was tools/src/quote-trigger/shadow.ts on launchd): drain
 * the middleware-fed event queue, debounce per phone in shared Redis,
 * classify (T1 photo-burst / T3 quote-promised / T2 Mike-debrief), and
 * run the drafter for triggered customers.
 *
 * The worker's per-minute cron calls runTick(); a Redis NX lock serializes
 * runs (doc numbers must not race). All state is in Redis so the cloud
 * worker and any manual CLI run share one view.
 */
import { randomUUID } from 'node:crypto';
import { keys } from '@aac/shared-utils/redis';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { lastFirstTokens } from '@aac/customers';
import type { DraftThreadMessage } from '@aac/quoting';
import { loadAssets } from './assets.js';
import { draftOne, prepareRun, type RunContext } from './drafter.js';
import { loadFieldChannel, type FieldChannel } from './field-context.js';
import { runScopeGate, type GateVerdict } from './gate.js';
import { flagScopeChange } from './flags.js';
import type { OpenQuoteEntry } from '@aac/shared-utils/types';
import { getOpenQuote, syncOpenQuoteIndex } from './open-quotes.js';
import {
  classify,
  DEBOUNCE_MS,
  INTERNAL,
  MAX_DRAFTS_PER_RUN,
  MAX_DRAIN_PER_RUN,
  T2_DEDUPE_H,
  T2_VISIT_LOOKBACK_H,
  T4_CONTEXT_MESSAGES,
  T4_DEDUPE_H,
  T4_MAX_VOICEMAIL_RETRIES,
  T4_VOICEMAIL_RETRY_MS,
  type DrafterAssets,
  type DrafterDeps,
  type DrafterMode,
  routerOwnsEvent,
  type DraftRunRecord,
  type RoutedQuoteJob,
  type TriggerEvent,
  type TriggerRunlogEntry,
} from './types.js';

/**
 * Must outlive the worker's quote-tick function (maxDuration 800s): a lock
 * that expires mid-run lets the next tick in, and both pick the same next
 * DocNumber. 15 min > 800s.
 */
export const RUN_LOCK_TTL_MS = 15 * 60 * 1000;

/** Compare-and-delete: release the run lock only if this run still owns it. */
const RELEASE_LOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * Release the run lock iff it still holds `token`. If the lock expired and
 * another run took it, that run's lock is left alone (the old plain DEL
 * deleted it). Never throws: the TTL is the backstop.
 */
export async function releaseRunLock(deps: DrafterDeps, token: string): Promise<boolean> {
  try {
    const released = await deps.redis.eval(RELEASE_LOCK_LUA, [keys.quoteDrafterRunLock], [token]);
    if (released !== 1) deps.log('run lock no longer ours at release (expired or taken) — left alone');
    return released === 1;
  } catch (err) {
    deps.log(`run lock release failed (TTL will expire it): ${(err as Error).message.slice(0, 120)}`);
    return false;
  }
}
const RUNLOG_MAX = 500;

export interface TickSummary {
  mode: DrafterMode;
  skipped?: 'off' | 'locked' | 'no-assets';
  drained: number;
  due: number;
  settling: number;
  drafted: number;
  records: TriggerRunlogEntry[];
}

/** Resolve the effective mode: Redis override beats the env default. */
export async function resolveMode(deps: DrafterDeps, envMode: DrafterMode): Promise<DrafterMode> {
  const override = await deps.redis.get<string>(keys.quoteDrafterMode);
  if (override === 'off' || override === 'shadow' || override === 'live') return override;
  return envMode;
}

/**
 * T4 staging flag, independent of the global drafter mode (which is live
 * in prod — T4 must be able to shadow underneath it). DEFAULT SHADOW.
 * The global mode still caps it: global shadow ⇒ T4 at most shadow.
 */
export async function resolveT4Mode(deps: DrafterDeps, globalMode: 'shadow' | 'live'): Promise<DrafterMode> {
  const raw = await deps.redis.get<string>(keys.quoteDrafterT4Mode);
  const t4 = raw === 'off' || raw === 'shadow' || raw === 'live' ? raw : 'shadow';
  if (t4 === 'off') return 'off';
  return globalMode === 'shadow' ? 'shadow' : t4;
}

/** T2: match recent visit events to QBO customers by last-name token. */
export function resolveVisitCustomers(
  events: Array<{ summary: string; startMs: number }>,
  customers: Array<{ name: string; phones: string[] }>,
): Array<{ name: string; phone: string; eventSummary: string }> {
  const out: Array<{ name: string; phone: string; eventSummary: string }> = [];
  const seen = new Set<string>();
  for (const e of events) {
    const hay = e.summary.toLowerCase();
    for (const c of customers) {
      const { last } = lastFirstTokens(c.name);
      if (!last.length || !c.phones.length) continue;
      if (!last.some((t) => hay.includes(t))) continue;
      const phone = c.phones[0];
      if (seen.has(phone) || INTERNAL.has(phone)) continue;
      seen.add(phone);
      out.push({ name: c.name, phone, eventSummary: e.summary });
    }
  }
  return out;
}

async function appendRunlog(deps: DrafterDeps, entry: TriggerRunlogEntry): Promise<void> {
  try {
    await deps.redis.lpush(keys.quoteDrafterRunlog, JSON.stringify(entry));
    await deps.redis.ltrim(keys.quoteDrafterRunlog, 0, RUNLOG_MAX - 1);
  } catch {
    // runlog is observability, never a failure path
  }
}

/**
 * The inbound router hands a settled burst's quote decision to the loop:
 * the next tick drafts it under the run lock (doc numbers, ownership and
 * modes stay here), skipping the debounce and the T4 gate.
 */
export async function enqueueRoutedQuote(
  redis: DrafterDeps['redis'],
  phone: string,
  job: RoutedQuoteJob,
): Promise<void> {
  await redis.hset(keys.quoteTriggerRouted, { [phone]: JSON.stringify(job) });
  await redis.zadd(keys.quoteTriggerDue, { score: new Date(job.at).getTime(), member: phone });
}

/**
 * Drain the webhook-fed queue into the per-phone pending buffer and arm
 * the debounce clock. Returns the drain count and any debrief marker.
 * Events the inbound router owns are dropped when its quote route is live.
 */
async function drainQueue(
  deps: DrafterDeps,
  routerOwnsInbound: boolean,
): Promise<{ drained: number; debriefAt: string | null }> {
  let drained = 0;
  let debriefAt: string | null = null;
  for (;;) {
    const raw = await deps.redis.rpop<string | TriggerEvent>(keys.quoteTriggerQueue);
    if (raw === null || raw === undefined) break;
    const ev: TriggerEvent = typeof raw === 'string' ? JSON.parse(raw) : raw;
    drained++;
    if (ev.kind === 'mike-debrief') {
      debriefAt = ev.at;
      continue;
    }
    if (INTERNAL.has(ev.phone)) continue;
    if (routerOwnsInbound && routerOwnsEvent(ev)) continue;
    const existing = (await deps.redis.hget<TriggerEvent[]>(keys.quoteTriggerPending, ev.phone)) ?? [];
    existing.push(ev);
    await deps.redis.hset(keys.quoteTriggerPending, { [ev.phone]: JSON.stringify(existing) });
    // A routed job is due now; Matt's own text must not push it out.
    if (routerOwnsInbound && (await deps.redis.hget(keys.quoteTriggerRouted, ev.phone))) continue;
    // GT: a newer event pushes the settle window out; an out-of-order
    // older event never pulls it in.
    const dueAt = new Date(ev.at).getTime() + DEBOUNCE_MS;
    await deps.redis.zadd(keys.quoteTriggerDue, { gt: true }, { score: dueAt, member: ev.phone });
    if (drained >= MAX_DRAIN_PER_RUN) break;
  }
  return { drained, debriefAt };
}

interface DraftExecution {
  phone: string;
  trigger: 'T1' | 'T2' | 'T3' | 'T4';
  why: string;
  events: number;
  hasNewInbound: boolean;
  customer: string | null;
  /** Inbound channel(s) for scope-flag notes when the draft turns out human-owned. */
  channel: string;
}

/** Human-readable channel label for one trigger event. */
function channelOf(e: TriggerEvent): string {
  if (e.kind === 'voicemail') return 'voicemail';
  if (e.kind === 'call-transcript') return 'call transcript';
  if (e.kind === 'email') return 'email';
  return e.hasMedia ? 'photos' : 'text';
}

function channelsOf(events: TriggerEvent[]): string {
  return [...new Set(events.map(channelOf))].join(' + ') || 'text';
}

/**
 * T4 scope-change evaluation for a settled phone whose events matched no
 * T1/T3 pattern. Runs only when an open quote exists for the phone. Owns
 * its runlog entries; returns a draft job only for the bot-owned path.
 */
async function evaluateT4(
  deps: DrafterDeps,
  mode: 'shadow' | 'live',
  phone: string,
  events: TriggerEvent[],
): Promise<DraftExecution | null> {
  const now = deps.now();
  const at = new Date(now).toISOString();
  const logEntry = (entry: Omit<TriggerRunlogEntry, 'at' | 'mode' | 'phone' | 'events'>) =>
    appendRunlog(deps, { at, mode, phone, events: events.length, ...entry });

  const inbound = events.filter((e) => e.direction === 'incoming');
  if (!inbound.length) {
    await logEntry({ trigger: 'none' });
    return null;
  }
  const open = await getOpenQuote(deps.redis, phone);
  if (!open) {
    await logEntry({ trigger: 'none' });
    return null;
  }

  const lastDone = await t4Deduped(deps, open);
  if (lastDone) {
    await logEntry({ trigger: 'none', why: `T4 deduped — #${open.docNumber} actioned ${lastDone}` });
    return null;
  }

  // ── assemble the new inbound content, fetching call bodies by callId
  const content: string[] = [];
  let voicemailPending = false;
  for (const e of inbound) {
    if (e.kind === 'call-transcript' && e.callId) {
      const t = await deps.quo.getCallTranscript(e.callId).catch(() => null);
      const text = (t?.dialogue ?? [])
        .map((d) => `${d.identifier ?? d.userId ?? '?'}: ${d.content}`)
        .join('\n');
      content.push(text ? `[call transcript ${e.at}]\n${text}` : `[call ${e.at}] (transcript unavailable)`);
    } else if (e.kind === 'voicemail' && e.callId) {
      const v = await deps.quo.getCallVoicemail(e.callId).catch(() => null);
      if (!v) continue; // rang out, no voicemail left
      if (v.status === 'completed' && v.transcript) {
        content.push(`[voicemail ${e.at}]\n${v.transcript}`);
      } else if (v.status === 'failed') {
        content.push(`[voicemail ${e.at}] (left a voicemail — transcription failed)`);
      } else {
        voicemailPending = true;
      }
    } else if (e.snippet || e.hasMedia) {
      content.push(`[${channelOf(e)} ${e.at}] ${e.snippet}${e.hasMedia ? ' [photo attached]' : ''}`);
    }
  }

  // Transcription lags the call webhook — re-arm the whole buffer and retry.
  if (voicemailPending) {
    const retries = Math.max(0, ...inbound.map((e) => e.retries ?? 0));
    if (retries < T4_MAX_VOICEMAIL_RETRIES) {
      const rearmed = events.map((e) => (e.kind === 'voicemail' ? { ...e, retries: retries + 1 } : e));
      await deps.redis.hset(keys.quoteTriggerPending, { [phone]: JSON.stringify(rearmed) });
      await deps.redis.zadd(
        keys.quoteTriggerDue,
        { gt: true },
        { score: now + T4_VOICEMAIL_RETRY_MS, member: phone },
      );
      await logEntry({ trigger: 'none', why: `T4 voicemail transcription pending — retry ${retries + 1}` });
      return null;
    }
    content.push('[voicemail] (left a voicemail — transcript never became available)');
  }
  if (!content.length) {
    await logEntry({ trigger: 'none' });
    return null;
  }

  // ── recent thread for context (fire-safe; the gate works without it)
  let context: DraftThreadMessage[] = [];
  try {
    const page = await deps.quo.listMessages({ participantE164: phone, maxResults: T4_CONTEXT_MESSAGES });
    context = [...page.data]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((m) => ({
        direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
        at: m.createdAt,
        text: m.text || (m.media?.length ? '[photo]' : ''),
      }));
  } catch {
    // context is optional
  }

  deps.log(`→ ${phone}: T4 gate on quote #${open.docNumber} (${content.length} new inbound block(s))`);
  let verdict: GateVerdict | null;
  try {
    verdict = await runScopeGate(deps, { open, newContent: content, context });
  } catch (err) {
    await logEntry({
      trigger: 'T4',
      why: 'gate call failed',
      record: { phone, customer: open.customer, outcome: 'failed', detail: (err as Error).message.slice(0, 200) },
    });
    return null;
  }
  if (!verdict) {
    await logEntry({
      trigger: 'T4',
      why: 'gate unparseable',
      record: { phone, customer: open.customer, outcome: 'failed', detail: 'gate response unparseable' },
    });
    return null;
  }
  if (!verdict.scopeRelevant) {
    deps.log(`  gate: not scope-relevant — ${verdict.reason}`);
    await logEntry({
      trigger: 'T4',
      why: verdict.reason,
      record: { phone, customer: open.customer, outcome: 'skipped', detail: `gate said no: ${verdict.reason}` },
    });
    return null;
  }

  return actOnScopeChange(deps, mode, phone, events.length, open, verdict.reason, channelsOf(inbound), logEntry);
}

/** One T4 action per estimate per window. */
async function t4Deduped(deps: DrafterDeps, open: OpenQuoteEntry): Promise<string | null> {
  const lastDone = await deps.redis.hget<string>(keys.quoteTriggerT4Done, open.estimateId);
  return lastDone && deps.now() - new Date(lastDone).getTime() < T4_DEDUPE_H * 3_600_000 ? lastDone : null;
}

type T4Log = (entry: Omit<TriggerRunlogEntry, 'at' | 'mode' | 'phone' | 'events'>) => Promise<void>;

/**
 * A scope-relevant change on an open quote (the gate's or the router's
 * verdict): bot-owned → a draft job; otherwise flag, never touching the
 * estimate.
 */
async function actOnScopeChange(
  deps: DrafterDeps,
  mode: 'shadow' | 'live',
  phone: string,
  eventCount: number,
  open: OpenQuoteEntry,
  reason: string,
  channel: string,
  logEntry: T4Log,
): Promise<DraftExecution | null> {
  const at = new Date(deps.now()).toISOString();
  await deps.redis.hset(keys.quoteTriggerT4Done, { [open.estimateId]: at });
  if (open.botOwned) {
    return {
      phone,
      trigger: 'T4',
      why: reason,
      events: eventCount,
      hasNewInbound: true,
      customer: open.customer,
      channel,
    };
  }

  // Human-owned (or never bot-created): flag, never touch the estimate.
  await flagScopeChange(
    deps,
    {
      at,
      phone,
      customer: open.customer,
      docNumber: open.docNumber,
      estimateId: open.estimateId,
      total: open.total,
      reason,
      channel,
    },
    { dryRun: mode === 'shadow' },
  );
  await logEntry({
    trigger: 'T4',
    why: reason,
    record: {
      phone,
      customer: open.customer,
      outcome: 'flagged',
      detail: `#${open.docNumber} ($${open.total}) via ${channel}: ${reason}`,
      estimateId: open.estimateId,
      docNumber: open.docNumber,
      total: open.total,
    },
  });
  return null;
}

async function executeDraft(
  deps: DrafterDeps,
  mode: 'shadow' | 'live',
  t4Mode: DrafterMode,
  run: RunContext,
  assets: DrafterAssets,
  fieldChannel: FieldChannel | null,
  job: DraftExecution,
): Promise<TriggerRunlogEntry> {
  const lines: string[] = [];
  const jobDeps: DrafterDeps = { ...deps, log: (l) => { lines.push(l); deps.log(l); } };
  // T4 stages independently: a T4 job drafts dry while its flag is shadowed,
  // even when T1-T3 drafting is live.
  const dryRun = mode === 'shadow' || (job.trigger === 'T4' && t4Mode !== 'live');
  deps.log(`→ ${job.phone}: ${job.trigger} (${job.why}) — ${dryRun ? 'shadow' : 'LIVE'} drafting`);
  let record: DraftRunRecord;
  try {
    record = await draftOne(jobDeps, {
      finding: { phone: job.phone, customer: job.customer, title: `TRIGGER ${job.trigger}: ${job.why}` },
      run,
      assets,
      fieldChannel,
      dryRun,
      skipIfRecentEstimateDays: 30,
      hasNewInbound: job.hasNewInbound,
      flagHumanOwned: t4Mode !== 'off',
    });
    if (record.outcome === 'created') run.nextDocNumber++;
    // Scope-relevant trigger on a quote the bot must not touch → flag it.
    if (record.outcome === 'flagged' && record.estimateId && record.docNumber) {
      await flagScopeChange(
        jobDeps,
        {
          at: new Date(deps.now()).toISOString(),
          phone: job.phone,
          customer: record.customer,
          docNumber: record.docNumber,
          estimateId: record.estimateId,
          total: record.total ?? 0,
          reason: job.why,
          channel: job.channel,
        },
        { dryRun: mode === 'shadow' || t4Mode !== 'live' },
      );
    }
  } catch (err) {
    record = {
      phone: job.phone,
      customer: job.customer ?? '',
      outcome: 'failed',
      detail: (err as Error).message.slice(0, 300),
    };
    deps.log(`  ✗ failed: ${record.detail}`);
  }
  const entry: TriggerRunlogEntry = {
    at: new Date(deps.now()).toISOString(),
    mode: dryRun ? 'shadow' : 'live',
    phone: job.phone,
    trigger: job.trigger,
    why: job.why,
    events: job.events,
    record,
    logTail: lines.slice(-25).join('\n'),
  };
  await appendRunlog(deps, entry);
  return entry;
}

/** A routed T4: the router's read already judged the burst scope-relevant, so no gate call. */
async function routedT4(
  deps: DrafterDeps,
  mode: 'shadow' | 'live',
  phone: string,
  eventCount: number,
  job: RoutedQuoteJob,
): Promise<DraftExecution | null> {
  const logEntry: T4Log = (entry) =>
    appendRunlog(deps, { at: new Date(deps.now()).toISOString(), mode, phone, events: eventCount, ...entry });
  const open = await getOpenQuote(deps.redis, phone);
  if (!open) {
    await logEntry({ trigger: 'none', why: 'router T4: open quote no longer indexed' });
    return null;
  }
  const lastDone = await t4Deduped(deps, open);
  if (lastDone) {
    await logEntry({ trigger: 'none', why: `T4 deduped — #${open.docNumber} actioned ${lastDone}` });
    return null;
  }
  return actOnScopeChange(deps, mode, phone, eventCount, open, `${job.why} (inbound router)`, job.channel, logEntry);
}

export interface TickOptions {
  /**
   * The inbound router's quote route is live: drop the customer events it
   * owns at drain time (texts, photos, voicemails); its decisions arrive as
   * routed jobs instead.
   */
  routerOwnsInbound?: boolean;
}

/**
 * One trigger pass. Cheap when idle (a queue pop + a ZRANGE); only
 * prepares the QBO run context when something is actually due.
 */
export async function runTick(deps: DrafterDeps, envMode: DrafterMode, opts: TickOptions = {}): Promise<TickSummary> {
  const mode = await resolveMode(deps, envMode);
  const summary: TickSummary = { mode, drained: 0, due: 0, settling: 0, drafted: 0, records: [] };
  if (mode === 'off') {
    summary.skipped = 'off';
    return summary;
  }

  // Unique per run, so release can tell our lock from a later run's.
  const lockToken = `${deps.now()}:${randomUUID()}`;
  const locked = await deps.redis.set(keys.quoteDrafterRunLock, lockToken, {
    nx: true,
    px: RUN_LOCK_TTL_MS,
  });
  if (locked !== 'OK') {
    summary.skipped = 'locked';
    return summary;
  }

  try {
    const t4Mode = await resolveT4Mode(deps, mode);
    const { drained, debriefAt } = await drainQueue(deps, opts.routerOwnsInbound ?? false);
    summary.drained = drained;

    const now = deps.now();
    const duePhones = await deps.redis.zrange<string[]>(keys.quoteTriggerDue, 0, now, {
      byScore: true,
    });
    summary.due = duePhones.length;
    summary.settling = Math.max(0, (await deps.redis.zcard(keys.quoteTriggerDue)) - duePhones.length);

    const jobs: DraftExecution[] = [];
    for (const phone of duePhones) {
      if (jobs.length >= MAX_DRAFTS_PER_RUN) break; // rest stays armed for next tick
      const events = (await deps.redis.hget<TriggerEvent[]>(keys.quoteTriggerPending, phone)) ?? [];
      // consume BEFORE drafting (a wedged draft must not loop forever)
      await deps.redis.zrem(keys.quoteTriggerDue, phone);
      await deps.redis.hdel(keys.quoteTriggerPending, phone);
      const rawRouted = await deps.redis.hget<RoutedQuoteJob | string>(keys.quoteTriggerRouted, phone);
      if (rawRouted) {
        // The router judged this burst; any buffered events (Matt's own
        // texts) ride along in the same draft.
        await deps.redis.hdel(keys.quoteTriggerRouted, phone);
        const routed: RoutedQuoteJob = typeof rawRouted === 'string' ? JSON.parse(rawRouted) : rawRouted;
        if (routed.trigger === 'T4') {
          if (t4Mode === 'off') {
            await appendRunlog(deps, { at: new Date(now).toISOString(), mode, phone, trigger: 'none', why: 'router T4, T4 off', events: events.length + 1 });
            continue;
          }
          const t4Job = await routedT4(deps, t4Mode, phone, events.length + 1, routed);
          if (t4Job) jobs.push(t4Job);
          continue;
        }
        jobs.push({
          phone,
          trigger: routed.trigger,
          why: `${routed.why} (inbound router)`,
          events: events.length + 1,
          hasNewInbound: true,
          customer: null,
          channel: routed.channel,
        });
        continue;
      }
      const verdict = classify(events);
      if (!verdict) {
        // T4: no photo-burst/quote-promise, but an open quote may make this
        // inbound scope-relevant (gate decides). Owns its runlog entries.
        if (t4Mode === 'off') {
          await appendRunlog(deps, {
            at: new Date(now).toISOString(),
            mode,
            phone,
            trigger: 'none',
            events: events.length,
          });
          continue;
        }
        const t4Job = await evaluateT4(deps, t4Mode, phone, events);
        if (t4Job) jobs.push(t4Job);
        continue;
      }
      jobs.push({
        phone,
        trigger: verdict.trigger,
        why: verdict.why,
        events: events.length,
        hasNewInbound: events.some((e) => e.direction === 'incoming'),
        customer: null,
        channel: channelsOf(events.filter((e) => e.direction === 'incoming')),
      });
    }

    // T2: Mike debrief completed → draft the day's visited customers
    if (debriefAt && deps.calendar) {
      try {
        const rawEvents = await deps.calendar.listEvents({
          timeMin: new Date(now - T2_VISIT_LOOKBACK_H * 3_600_000).toISOString(),
          timeMax: new Date(now).toISOString(),
        });
        const visits = rawEvents.map((e) => ({ summary: e.summary, startMs: new Date(e.start).getTime() }));
        const qboCustomers = (await deps.qb.listAllCustomers()).map((c) => ({
          name: c.DisplayName,
          phones: [c.PrimaryPhone, c.Mobile, c.AlternatePhone]
            .map((p) => quickNormalizePhone(p?.FreeFormNumber))
            .filter((p): p is string => !!p),
        }));
        const customers = resolveVisitCustomers(visits, qboCustomers);
        deps.log(
          `T2 debrief at ${debriefAt}: ${visits.length} visit(s) in ${T2_VISIT_LOOKBACK_H}h window → ${customers.length} matched customer(s)`,
        );
        for (const c of customers) {
          if (jobs.length >= MAX_DRAFTS_PER_RUN) break;
          const last = await deps.redis.hget<string>(keys.quoteTriggerT2Done, c.phone);
          if (last && now - new Date(last).getTime() < T2_DEDUPE_H * 3_600_000) continue;
          await deps.redis.hset(keys.quoteTriggerT2Done, { [c.phone]: new Date(now).toISOString() });
          jobs.push({
            phone: c.phone,
            trigger: 'T2',
            why: `Mike debrief after visit "${c.eventSummary}"`,
            events: 1,
            hasNewInbound: true, // the debrief itself is new field evidence
            customer: c.name,
            channel: 'call transcript',
          });
        }
      } catch (err) {
        deps.log(`T2 handling failed: ${(err as Error).message.slice(0, 120)}`);
      }
    }

    if (jobs.length > 0 && (mode === 'shadow' || mode === 'live')) {
      const assets = await loadAssets(deps.redis);
      if (!assets) {
        deps.log('no asset manifest in Redis — cannot draft (run sync-assets)');
        summary.skipped = 'no-assets';
        return summary;
      }
      const run = await prepareRun(deps);
      const fieldChannel = await loadFieldChannel(deps);
      for (const job of jobs) {
        const entry = await executeDraft(deps, mode, t4Mode, run, assets, fieldChannel, job);
        summary.records.push(entry);
        summary.drafted++;
      }
    }

    // prune old T2 dedupe entries
    const t2 = ((await deps.redis.hgetall(keys.quoteTriggerT2Done)) ?? {}) as Record<string, string>;
    for (const [p, at] of Object.entries(t2)) {
      if (now - new Date(at).getTime() > 7 * 86_400_000) {
        await deps.redis.hdel(keys.quoteTriggerT2Done, p);
      }
    }

    // T4 open-quote index upkeep (self-gates to every 30 min; fire-safe)
    try {
      await syncOpenQuoteIndex(deps);
    } catch (err) {
      deps.log(`open-quote index sync failed: ${(err as Error).message.slice(0, 120)}`);
    }

    return summary;
  } finally {
    await releaseRunLock(deps, lockToken);
  }
}
