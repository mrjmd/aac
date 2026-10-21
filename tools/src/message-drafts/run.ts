#!/usr/bin/env npx tsx
/**
 * Message-drafts LAPTOP BACKSTOP runner — thin wrapper over
 * @aac/message-drafts (all logic + state live there / in Redis since the
 * launchd → server-workers P1 migration, 2026-10-21; the Vercel worker in
 * apps/worker is the primary). Shared Redis claims make it safe for this
 * runner and the worker to overlap — whoever claims first drafts.
 *
 * Every 60s launchd tick: drain the webhook-fed fast queues.
 * Every 10 min: full sweep (36h QBO lookback + 6h Quo conversation poll).
 *
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
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import {
  RedisDraftState,
  type DraftDeps,
  MAX_DRAFTS_PER_RUN,
  drainFollowupQueue,
  drainIntakeDue,
  sweepFollowups,
  sweepIntake,
  draftFollowup,
  gateFollowup,
  draftIntake,
  draftCtRouting,
  gateCtRouting,
  ctRoutingFallback,
  buildLucHandoff,
  pickExemplars,
  FOLLOWUP_EXEMPLARS,
  INTAKE_EXEMPLARS,
  CT_ROUTING_EXEMPLARS,
} from '@aac/message-drafts';

const SWEEP_INTERVAL_MIN = 10;

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
  const seed = Math.floor(now / 600_000);

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
  const deps: DraftDeps = { qb, quo, gemini, state: new RedisDraftState(redis), dryRun };

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
    const draft = await draftFollowup(gemini, { firstName, scopeLines, exemplars: pickExemplars(FOLLOWUP_EXEMPLARS, 6, seed) });
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
      exemplars: pickExemplars(INTAKE_EXEMPLARS, 6, seed),
    });
    console.log(`\n── probe intake ${probePhone} (classification: ${result?.classification}, state: ${result?.propertyState}, provided: ${JSON.stringify(result?.provided)}, extracted: ${JSON.stringify(result?.extracted)}) ──`);
    if (result?.classification === 'lead' && result.propertyState === 'CT') {
      const reply = await draftCtRouting(gemini, { customerText, exemplars: pickExemplars(CT_ROUTING_EXEMPLARS, 6, seed) });
      const gateFail = reply ? gateCtRouting(reply) : 'generation failed';
      if (gateFail) console.log(`[GATE FAIL: ${gateFail} — fallback would be used]`);
      console.log('── customer reply ──');
      console.log(gateFail ? ctRoutingFallback(result.extracted.name?.split(' ')[0] ?? null) : reply);
      console.log('── handoff to Luc ──');
      const mediaUrls = inbound.flatMap((m) => (m.media ?? []).map((x) => x.url)).filter(Boolean);
      console.log(buildLucHandoff({ phone: probePhone, extracted: result.extracted, customerText, mediaUrls }));
      return;
    }
    console.log(result?.draft || '(no draft — non-lead or generation failed)');
    return;
  }

  // ── normal tick ────────────────────────────────────────────────
  const firstRunAt = await deps.state.getFirstRunAt();
  const firstRun = !firstRunAt;
  if (firstRun && !dryRun) await deps.state.setFirstRunAt(new Date(now).toISOString());

  const records = [
    ...(await drainFollowupQueue(deps, redis)),
    ...(await drainIntakeDue(deps, redis)),
  ];

  const lastSweep = await redis.get<string>(keys.messageDraftLastSweep);
  const sweepDue = !lastSweep || now - new Date(lastSweep).getTime() >= SWEEP_INTERVAL_MIN * 60_000;
  if (sweepDue || dryRun) {
    if (!dryRun) await redis.set(keys.messageDraftLastSweep, new Date(now).toISOString());
    records.push(...(await sweepFollowups(deps, { maxDrafts: MAX_DRAFTS_PER_RUN, firstRun })));
    records.push(...(await sweepIntake(deps, { maxDrafts: MAX_DRAFTS_PER_RUN })));
  }

  const drafted = records.filter((r) => r.outcome === 'drafted').length;
  console.log(`done — ${drafted} draft(s), ${records.length} record(s)${dryRun ? ' [dry-run]' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
