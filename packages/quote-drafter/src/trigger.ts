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
import { keys } from '@aac/shared-utils/redis';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { nameTokens } from '@aac/quoting';
import { loadAssets } from './assets.js';
import { draftOne, prepareRun, type RunContext } from './drafter.js';
import { loadFieldChannel, type FieldChannel } from './field-context.js';
import {
  classify,
  DEBOUNCE_MS,
  INTERNAL,
  MAX_DRAFTS_PER_RUN,
  MAX_DRAIN_PER_RUN,
  T2_DEDUPE_H,
  T2_VISIT_LOOKBACK_H,
  type DrafterAssets,
  type DrafterDeps,
  type DrafterMode,
  type DraftRunRecord,
  type TriggerEvent,
  type TriggerRunlogEntry,
} from './types.js';

const RUN_LOCK_TTL_MS = 10 * 60 * 1000;
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
      const { last } = nameTokens(c.name);
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
 * Drain the webhook-fed queue into the per-phone pending buffer and arm
 * the debounce clock. Returns the drain count and any debrief marker.
 */
async function drainQueue(deps: DrafterDeps): Promise<{ drained: number; debriefAt: string | null }> {
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
    const existing = (await deps.redis.hget<TriggerEvent[]>(keys.quoteTriggerPending, ev.phone)) ?? [];
    existing.push(ev);
    await deps.redis.hset(keys.quoteTriggerPending, { [ev.phone]: JSON.stringify(existing) });
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
  trigger: 'T1' | 'T2' | 'T3';
  why: string;
  events: number;
  hasNewInbound: boolean;
  customer: string | null;
}

async function executeDraft(
  deps: DrafterDeps,
  mode: 'shadow' | 'live',
  run: RunContext,
  assets: DrafterAssets,
  fieldChannel: FieldChannel | null,
  job: DraftExecution,
): Promise<TriggerRunlogEntry> {
  const lines: string[] = [];
  const jobDeps: DrafterDeps = { ...deps, log: (l) => { lines.push(l); deps.log(l); } };
  deps.log(`→ ${job.phone}: ${job.trigger} (${job.why}) — ${mode === 'shadow' ? 'shadow' : 'LIVE'} drafting`);
  let record: DraftRunRecord;
  try {
    record = await draftOne(jobDeps, {
      finding: { phone: job.phone, customer: job.customer, title: `TRIGGER ${job.trigger}: ${job.why}` },
      run,
      assets,
      fieldChannel,
      dryRun: mode === 'shadow',
      skipIfRecentEstimateDays: 30,
      hasNewInbound: job.hasNewInbound,
    });
    if (record.outcome === 'created') run.nextDocNumber++;
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
    mode,
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

/**
 * One trigger pass. Cheap when idle (a queue pop + a ZRANGE); only
 * prepares the QBO run context when something is actually due.
 */
export async function runTick(deps: DrafterDeps, envMode: DrafterMode): Promise<TickSummary> {
  const mode = await resolveMode(deps, envMode);
  const summary: TickSummary = { mode, drained: 0, due: 0, settling: 0, drafted: 0, records: [] };
  if (mode === 'off') {
    summary.skipped = 'off';
    return summary;
  }

  const locked = await deps.redis.set(keys.quoteDrafterRunLock, deps.now(), {
    nx: true,
    px: RUN_LOCK_TTL_MS,
  });
  if (locked !== 'OK') {
    summary.skipped = 'locked';
    return summary;
  }

  try {
    const { drained, debriefAt } = await drainQueue(deps);
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
      const verdict = classify(events);
      if (!verdict) {
        await appendRunlog(deps, {
          at: new Date(now).toISOString(),
          mode,
          phone,
          trigger: 'none',
          events: events.length,
        });
        continue;
      }
      jobs.push({
        phone,
        trigger: verdict.trigger,
        why: verdict.why,
        events: events.length,
        hasNewInbound: events.some((e) => e.direction === 'incoming'),
        customer: null,
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
        const entry = await executeDraft(deps, mode, run, assets, fieldChannel, job);
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

    return summary;
  } finally {
    await deps.redis.del(keys.quoteDrafterRunLock);
  }
}
