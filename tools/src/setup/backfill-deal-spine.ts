#!/usr/bin/env npx tsx
/**
 * One-shot backfill for the PD deal spine.
 *
 * Crawl step 6 of `docs/projects/apps-agent.md`. Walks two backfill sources:
 *
 *   Phase A — QB estimates: every currently-open (Pending or Accepted)
 *     estimate gets a PD deal at quote_sent / quote_accepted, dedup'd by
 *     `external_id = qb-est-{id}` so re-runs are idempotent.
 *
 *   Phase B — Calendar events: every recent green (color 10, job) and purple
 *     (color 3, assessment) event gets attached to a deal — either an
 *     existing open deal for the same person (preferred, so we don't
 *     fragment the spine), or a new deal at job_scheduled / assessment_scheduled.
 *     Then stamps a `[deal:N]` marker on the event description so future
 *     reads (crons, agent context tool) get the canonical link.
 *
 * SEQUENCING — DO NOT --apply BLIND:
 *   Running the estimate phase with --apply before Funnel A Phase 1 cleanup
 *   will mint dozens of deals for stale opportunities (37 of the 77 currently
 *   Pending estimates are 90+ days old per the 2026-05-22 inventory). Do the
 *   cleanup pass first; see analysis/02-strategy/funnel-a-dormant-reactivation.md
 *   §"Phase 1 — pipeline cleanup". The script defaults to --dry-run for this
 *   reason — --apply requires Matt's explicit go-ahead after cleanup runs.
 *
 * FLAGS:
 *   --apply                  Do the writes. Without this, dry-run only.
 *   --phase=estimates|events|all   Default: all
 *   --event-lookback-days=N  Default: 180. Past N days of calendar history to scan.
 *   --limit-estimates=N      Cap how many estimates this run processes (debug).
 *   --limit-events=N         Cap how many events this run processes (debug).
 *
 * NOTE: Output JSON goes to `tools/src/scratch/spike-output/` (gitignored)
 * because the per-record reports contain customer / person IDs from the
 * live data. The script itself lives in `setup/` (committed) because it's
 * a maintained one-shot setup tool, mirroring `pd-deal-fields.ts`.
 *
 * READ-ONLY HELPERS (used in dry-run mode too):
 *   - Estimate phase: same logic as the nightly deal-reconcile cron, just
 *     unbounded in time. estimateStatusToStage is inlined here (apps/middleware
 *     internal) — see apps/middleware/lib/deal-reconcile.ts for the canonical
 *     copy. Keep them in sync; any change to the QB → stage mapping should
 *     happen in both places.
 *   - Event phase: event → person via PipedriveID marker → name search →
 *     compound-name fallback. Mirrors apps/middleware/lib/job-customer-match.ts
 *     but without the deal-marker preempt (events being backfilled are exactly
 *     the ones lacking that marker).
 *
 * OUTPUT:
 *   - Per-phase counters printed at end (created, linked, advanced, skipped)
 *   - JSON dump at tools/src/scratch/spike-output/backfill-deal-spine-<date>.json
 *     with per-record actions for review
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PipedriveClient,
  DEAL_PIPELINE_ID,
  DEAL_STAGE_IDS,
  DEAL_FIELD_HASHES,
  type DealStage,
  type PipedrivePerson,
} from '@aac/api-clients/pipedrive';
import {
  QuickBooksClient,
  type QBEstimate,
} from '@aac/api-clients/quickbooks';
import {
  GoogleCalendarClient,
  type CalendarEvent,
} from '@aac/api-clients/google-calendar';
import { keys } from '@aac/shared-utils/redis';

// ── Env loading ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envText = readFileSync(resolve(__dirname, '../../../.env.diagnostic'), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// ── CLI args ─────────────────────────────────────────────────────

interface Args {
  apply: boolean;
  phase: 'estimates' | 'events' | 'all';
  eventLookbackDays: number;
  limitEstimates: number | null;
  limitEvents: number | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=', 2)[1] : undefined;
  };
  const apply = args.includes('--apply');
  const phaseRaw = get('phase') ?? 'all';
  if (!['estimates', 'events', 'all'].includes(phaseRaw)) {
    throw new Error(`Invalid --phase=${phaseRaw}. Use estimates | events | all.`);
  }
  const eventLookbackDays = parseInt(get('event-lookback-days') ?? '180', 10);
  const limitEstimatesRaw = get('limit-estimates');
  const limitEventsRaw = get('limit-events');
  return {
    apply,
    phase: phaseRaw as Args['phase'],
    eventLookbackDays,
    limitEstimates: limitEstimatesRaw ? parseInt(limitEstimatesRaw, 10) : null,
    limitEvents: limitEventsRaw ? parseInt(limitEventsRaw, 10) : null,
  };
}

const argv = parseArgs();

// ── Upstash REST (mapping cache lookup) ──────────────────────────

const redisUrl = process.env.UPSTASH_REDIS_REST_URL!;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN!;

async function redisGet<T>(k: string): Promise<T | null> {
  const r = await fetch(`${redisUrl}/get/${encodeURIComponent(k)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  const j = (await r.json()) as { result: string | null };
  if (!j.result) return null;
  // mapping values are stored as raw strings; JSON dumps fail on bare strings
  try {
    return JSON.parse(j.result) as T;
  } catch {
    return j.result as unknown as T;
  }
}

async function redisSet(k: string, v: unknown, ttlSeconds: number): Promise<void> {
  await fetch(`${redisUrl}/set/${encodeURIComponent(k)}?EX=${ttlSeconds}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}` },
    body: JSON.stringify(v),
  });
}

// ── Clients ──────────────────────────────────────────────────────

const pd = new PipedriveClient({
  apiKey: process.env.PIPEDRIVE_API_KEY!,
  companyDomain: process.env.PIPEDRIVE_COMPANY_DOMAIN!,
  dealSpine: {
    pipelineId: DEAL_PIPELINE_ID,
    stageIds: DEAL_STAGE_IDS,
    fieldHashes: DEAL_FIELD_HASHES,
  },
});

const qb = new QuickBooksClient({
  clientId: process.env.QUICKBOOKS_CLIENT_ID!,
  clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET!,
  realmId: process.env.QUICKBOOKS_REALM_ID!,
  redirectUri: process.env.QUICKBOOKS_REDIRECT_URI!,
  getTokens: () => redisGet(keys.qbOAuthTokens),
  // 90-day TTL matches the QBO refresh-token expiry window. The token object
  // is stored as JSON (single-encoded — `redisSet` calls JSON.stringify once).
  saveTokens: (t) => redisSet(keys.qbOAuthTokens, t, 60 * 60 * 24 * 90),
});

const cal = new GoogleCalendarClient({
  calendarId: process.env.GOOGLE_CALENDAR_ID ?? 'matt@attackacrack.com',
  oauth: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  },
});

// ── Stage mappings ───────────────────────────────────────────────

/**
 * Mirror of apps/middleware/lib/deal-reconcile.ts:estimateStatusToStage.
 * Inlined because tools/ can't import middleware internals.
 */
function estimateStatusToStage(status: QBEstimate['TxnStatus']): DealStage | null {
  switch (status) {
    case 'Accepted':
    case 'Converted':
      return 'quote_accepted';
    case 'Pending':
    case undefined:
      return 'quote_sent';
    case 'Rejected':
    case 'Closed':
      return null;
    default:
      return null;
  }
}

/** Past green/purple events have already happened; backfilled deals should reflect that. */
function eventStageFor(event: CalendarEvent): DealStage {
  const isPast = new Date(event.end).getTime() < Date.now();
  if (event.colorId === '10') return isPast ? 'job_done' : 'job_scheduled';
  if (event.colorId === '3') return isPast ? 'assessment_done' : 'assessment_scheduled';
  // Unknown color — assume future-job by default. Callers filter by color first.
  return 'job_scheduled';
}

// ── PD person resolution from QB customer ────────────────────────

/**
 * Resolve a QB Customer.Id to a PD Person.Id (numeric).
 * Cache-first via the 7-day Redis mapping; cold-cache lookup fetches the
 * QB customer record and searches PD by phone then email then display name.
 * Caches a hit back into Redis so the next run is warm.
 */
async function resolvePdPersonId(qbCustomerId: string): Promise<{
  personId: number | null;
  source: 'cache' | 'qb-phone' | 'qb-name' | 'unmatched';
}> {
  const cacheKey = keys.map.qbToPipedrive(qbCustomerId);
  const cached = await redisGet<string>(cacheKey);
  if (cached) {
    const n = parseInt(cached, 10);
    if (Number.isFinite(n)) return { personId: n, source: 'cache' };
  }

  const customer = await qb.getCustomer(qbCustomerId);
  if (!customer) return { personId: null, source: 'unmatched' };

  const phone = customer.PrimaryPhone?.FreeFormNumber;
  if (phone) {
    const hit = await pd.searchPersonByPhone(phone);
    if (hit) {
      if (argv.apply) {
        await redisSet(cacheKey, String(hit.id), 60 * 60 * 24 * 7);
      }
      return { personId: hit.id, source: 'qb-phone' };
    }
  }

  if (customer.DisplayName) {
    const hit = await pd.searchPersonByName(customer.DisplayName);
    if (hit) {
      if (argv.apply) {
        await redisSet(cacheKey, String(hit.id), 60 * 60 * 24 * 7);
      }
      return { personId: hit.id, source: 'qb-name' };
    }
  }

  return { personId: null, source: 'unmatched' };
}

// ── Phase A: estimate backfill ───────────────────────────────────

interface EstimateAction {
  estimateId: string;
  docNumber: string | undefined;
  customerId: string | undefined;
  txnStatus: QBEstimate['TxnStatus'];
  action:
    | 'skip-terminal'
    | 'skip-no-customer'
    | 'skip-no-mapping'
    | 'already-linked'
    | 'would-create'
    | 'created'
    | 'would-advance'
    | 'advanced';
  dealId?: number;
  fromStage?: DealStage | null;
  toStage?: DealStage;
  personId?: number;
  matchSource?: string;
  note?: string;
}

async function listAllOpenEstimates(): Promise<QBEstimate[]> {
  // Same pagination shape as inventory-dormant-estimates.ts — no time window.
  const all: QBEstimate[] = [];
  const pageSize = 1000;
  let pos = 1;
  while (true) {
    const sql = `SELECT * FROM Estimate STARTPOSITION ${pos} MAXRESULTS ${pageSize}`;
    const res = await qb.query<{ QueryResponse?: { Estimate?: QBEstimate[] } }>(sql);
    const batch = res.QueryResponse?.Estimate ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    process.stdout.write(`  fetched ${all.length} estimates...\r`);
    if (batch.length < pageSize) break;
    pos += pageSize;
  }
  process.stdout.write('\n');
  return all.filter((e) => e.TxnStatus !== 'Rejected' && e.TxnStatus !== 'Closed');
}

async function backfillEstimates(): Promise<EstimateAction[]> {
  console.log('\n=== Phase A: QB estimates ===');
  const estimates = await listAllOpenEstimates();
  const slice = argv.limitEstimates ? estimates.slice(0, argv.limitEstimates) : estimates;
  console.log(`  ${estimates.length} open estimates (${slice.length} after limit)`);

  const actions: EstimateAction[] = [];
  let i = 0;
  for (const est of slice) {
    i += 1;
    process.stdout.write(`  ${i}/${slice.length}: estimate ${est.Id}...\r`);

    const customerId = est.CustomerRef?.value;
    if (!customerId) {
      actions.push({
        estimateId: est.Id,
        docNumber: est.DocNumber,
        customerId,
        txnStatus: est.TxnStatus,
        action: 'skip-no-customer',
      });
      continue;
    }

    const targetStage = estimateStatusToStage(est.TxnStatus);
    if (!targetStage) {
      actions.push({
        estimateId: est.Id,
        docNumber: est.DocNumber,
        customerId,
        txnStatus: est.TxnStatus,
        action: 'skip-terminal',
      });
      continue;
    }

    const externalId = `qb-est-${est.Id}`;
    const existing = await pd.findDealByExternalId(externalId);
    if (existing) {
      // Already linked. Optionally advance stage; mirror reconcile's monotonic rule.
      const currentRank = stageRank(existing.stage);
      const targetRank = stageRank(targetStage);
      if (targetRank > currentRank) {
        if (argv.apply) {
          await pd.setDealStage(existing.id, targetStage);
        }
        actions.push({
          estimateId: est.Id,
          docNumber: est.DocNumber,
          customerId,
          txnStatus: est.TxnStatus,
          action: argv.apply ? 'advanced' : 'would-advance',
          dealId: existing.id,
          fromStage: existing.stage,
          toStage: targetStage,
        });
      } else {
        actions.push({
          estimateId: est.Id,
          docNumber: est.DocNumber,
          customerId,
          txnStatus: est.TxnStatus,
          action: 'already-linked',
          dealId: existing.id,
          fromStage: existing.stage,
          toStage: targetStage,
        });
      }
      continue;
    }

    const { personId, source } = await resolvePdPersonId(customerId);
    if (!personId) {
      actions.push({
        estimateId: est.Id,
        docNumber: est.DocNumber,
        customerId,
        txnStatus: est.TxnStatus,
        action: 'skip-no-mapping',
        matchSource: source,
      });
      continue;
    }

    const title = `Quote ${est.DocNumber ?? est.Id}`;
    if (argv.apply) {
      const created = await pd.createDeal({
        title,
        personId,
        stage: targetStage,
        qbEstimateId: est.Id,
        externalId,
      });
      actions.push({
        estimateId: est.Id,
        docNumber: est.DocNumber,
        customerId,
        txnStatus: est.TxnStatus,
        action: 'created',
        dealId: created.id,
        toStage: targetStage,
        personId,
        matchSource: source,
      });
    } else {
      actions.push({
        estimateId: est.Id,
        docNumber: est.DocNumber,
        customerId,
        txnStatus: est.TxnStatus,
        action: 'would-create',
        toStage: targetStage,
        personId,
        matchSource: source,
      });
    }
  }
  process.stdout.write('\n');
  return actions;
}

// ── Phase B: calendar event backfill ─────────────────────────────

interface EventAction {
  eventId: string;
  summary: string;
  start: string;
  colorId: string | undefined;
  action:
    | 'skip-no-person'
    | 'skip-existing-marker'
    | 'skip-already-backfilled'
    | 'skip-ambiguous-deals'
    | 'would-link-existing'
    | 'linked-existing'
    | 'would-create'
    | 'created';
  dealId?: number;
  personId?: number;
  toStage?: DealStage;
  matchSource?: string;
  note?: string;
}

const DEAL_MARKER_REGEX = /\[deal:\d+\]/i;

/**
 * Resolve event → person without using the [deal:N] marker (events being
 * backfilled are exactly those lacking the marker). Mirrors the PipedriveID
 * → name → compound-name sequence from middleware's matchEventToPerson.
 */
async function matchEventToPersonForBackfill(
  event: CalendarEvent,
): Promise<{ person: PipedrivePerson | null; source: string }> {
  const pidMatch = event.description?.match(/PipedriveID:\s*(\d+)/i);
  if (pidMatch) {
    const person = await pd.getPerson(parseInt(pidMatch[1], 10));
    if (person) return { person, source: 'pipedrive-marker' };
  }

  const direct = await pd.searchPersonByName(event.summary);
  if (direct) {
    const person = await pd.getPerson(direct.id);
    if (person) return { person, source: 'name' };
  }

  // Compound-name fallback ("Lisa & John Smith" → try each token group).
  // Light version: split on '&' and 'and', search each side.
  const candidates = event.summary
    .split(/\s*(?:&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  for (const candidate of candidates) {
    if (candidate === event.summary) continue;
    const hit = await pd.searchPersonByName(candidate);
    if (hit) {
      const person = await pd.getPerson(hit.id);
      if (person) return { person, source: 'compound-name' };
    }
  }

  return { person: null, source: 'unmatched' };
}

/** Stamp [deal:N] onto an event description without duplicating the marker. */
function stampDealMarker(description: string | undefined, dealId: number): string {
  const marker = `[deal:${dealId}]`;
  if (!description) return marker;
  if (DEAL_MARKER_REGEX.test(description)) return description;
  return `${description}\n${marker}`;
}

async function backfillEvents(): Promise<EventAction[]> {
  console.log('\n=== Phase B: calendar events ===');

  const now = Date.now();
  const timeMin = new Date(now - argv.eventLookbackDays * 24 * 60 * 60 * 1000).toISOString();
  // Look slightly into the future too — events scheduled in the near future
  // also lack markers when backfilling from history-only state.
  const timeMax = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

  const events = await cal.listEvents({
    timeMin,
    timeMax,
    colorIds: ['10', '3'],
    excludeKeywords: ['lunch', 'dinner', 'meeting'],
  });
  const slice = argv.limitEvents ? events.slice(0, argv.limitEvents) : events;
  console.log(`  ${events.length} green/purple events (${slice.length} after limit)`);

  const actions: EventAction[] = [];
  let i = 0;
  for (const event of slice) {
    i += 1;
    process.stdout.write(`  ${i}/${slice.length}: ${event.summary.slice(0, 40)}...\r`);

    // Skip if event already has a [deal:N] marker — it's already linked.
    if (event.description && DEAL_MARKER_REGEX.test(event.description)) {
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'skip-existing-marker',
      });
      continue;
    }

    // Skip if this event already minted a backfill deal (idempotent re-run).
    const existingByExt = await pd.findDealByExternalId(`gcal-${event.id}`);
    if (existingByExt) {
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'skip-already-backfilled',
        dealId: existingByExt.id,
      });
      continue;
    }

    const { person, source } = await matchEventToPersonForBackfill(event);
    if (!person) {
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'skip-no-person',
        matchSource: source,
      });
      continue;
    }

    // Prefer attaching to an existing open deal for this person rather than
    // creating a duplicate — keeps the spine consolidated.
    const personDeals = await pd.getDealsByPerson(person.id);
    const openDeals = personDeals.filter(
      (d) => d.status === 'open' && d.stage !== 'lost',
    );

    if (openDeals.length === 1) {
      const deal = openDeals[0];
      if (argv.apply) {
        await cal.updateEvent(event.id, {
          description: stampDealMarker(event.description, deal.id),
        });
      }
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: argv.apply ? 'linked-existing' : 'would-link-existing',
        dealId: deal.id,
        personId: person.id,
        matchSource: source,
        note: `linked to existing ${deal.stage ?? 'unknown'} deal`,
      });
      continue;
    }

    if (openDeals.length > 1) {
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'skip-ambiguous-deals',
        personId: person.id,
        matchSource: source,
        note: `${openDeals.length} open deals for person`,
      });
      continue;
    }

    // No open deals → create a new one at the event's implied stage.
    const targetStage = eventStageFor(event);
    const title = `${person.name} — ${event.summary}`.slice(0, 200);
    if (argv.apply) {
      const created = await pd.createDeal({
        title,
        personId: person.id,
        stage: targetStage,
        externalId: `gcal-${event.id}`,
      });
      await cal.updateEvent(event.id, {
        description: stampDealMarker(event.description, created.id),
      });
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'created',
        dealId: created.id,
        personId: person.id,
        toStage: targetStage,
        matchSource: source,
      });
    } else {
      actions.push({
        eventId: event.id,
        summary: event.summary,
        start: event.start,
        colorId: event.colorId,
        action: 'would-create',
        personId: person.id,
        toStage: targetStage,
        matchSource: source,
      });
    }
  }
  process.stdout.write('\n');
  return actions;
}

// ── Stage rank (local copy of cron.ts:dealStageRank) ─────────────

const DEAL_STAGE_ORDER: DealStage[] = [
  'lead',
  'qualified_lead',
  'assessment_scheduled',
  'assessment_done',
  'quote_sent',
  'quote_accepted',
  'job_scheduled',
  'job_done',
  'paid',
];

function stageRank(stage: DealStage | null): number {
  if (stage === null) return -1;
  if (stage === 'lost') return Infinity;
  const idx = DEAL_STAGE_ORDER.indexOf(stage);
  return idx === -1 ? -1 : idx;
}

// ── Main ─────────────────────────────────────────────────────────

interface RunOutput {
  generated_at: string;
  apply: boolean;
  phase: Args['phase'];
  estimates?: EstimateAction[];
  events?: EventAction[];
}

function summarize<T extends { action: string }>(actions: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of actions) {
    out[a.action] = (out[a.action] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<void> {
  const banner = argv.apply ? '!!! APPLY MODE (writes enabled) !!!' : 'DRY-RUN (no writes)';
  console.log(`Backfill deal spine — ${banner}`);
  console.log(`  phase=${argv.phase}  event-lookback-days=${argv.eventLookbackDays}`);
  if (argv.limitEstimates) console.log(`  limit-estimates=${argv.limitEstimates}`);
  if (argv.limitEvents) console.log(`  limit-events=${argv.limitEvents}`);

  const out: RunOutput = {
    generated_at: new Date().toISOString(),
    apply: argv.apply,
    phase: argv.phase,
  };

  if (argv.phase === 'estimates' || argv.phase === 'all') {
    out.estimates = await backfillEstimates();
    console.log('\nEstimate phase summary:');
    for (const [k, v] of Object.entries(summarize(out.estimates))) {
      console.log(`  ${k}: ${v}`);
    }
  }

  if (argv.phase === 'events' || argv.phase === 'all') {
    out.events = await backfillEvents();
    console.log('\nEvent phase summary:');
    for (const [k, v] of Object.entries(summarize(out.events))) {
      console.log(`  ${k}: ${v}`);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  // Per-record reports include customer + person IDs from live data, so
  // route them into the gitignored scratch sink rather than next to the
  // committed script.
  const outDir = resolve(__dirname, '../scratch/spike-output');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(
    outDir,
    `backfill-deal-spine-${date}${argv.apply ? '-apply' : '-dryrun'}.json`,
  );
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nReport: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
