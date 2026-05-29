#!/usr/bin/env npx tsx
/**
 * Scheduling backtest — replay past QB acceptances against the normalizer
 * and produce a diff table vs. what actually got scheduled.
 *
 * The trust-building Crawl tool for the @aac/scheduling pipeline. See
 * `docs/projects/scheduling.md`.
 *
 * Usage:
 *   npx tsx tools/src/scheduling-backtest.ts                     # default 90d window
 *   npx tsx tools/src/scheduling-backtest.ts --from 2026-02-28 --to 2026-05-29
 *   npx tsx tools/src/scheduling-backtest.ts --phone +16175550123
 *
 * All business logic lives in `@aac/scheduling/replay`. This file is wiring.
 */

import { randomUUID } from 'node:crypto';
import { PipedriveClient, DEAL_PIPELINE_ID, DEAL_STAGE_IDS, DEAL_FIELD_HASHES } from '@aac/api-clients/pipedrive';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { keys } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import { replayQbApprovals, type BacktestRow, type BacktestSummary } from '@aac/scheduling';

// ── CLI args ──────────────────────────────────────────────────────

interface Args {
  phone?: string;
  from: Date;
  to: Date;
  matchWindowDays: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return {
    phone: get('phone'),
    from: get('from') ? new Date(get('from')!) : defaultFrom,
    to: get('to') ? new Date(get('to')!) : now,
    matchWindowDays: parseInt(get('match-window') ?? '30', 10),
  };
}

// ── Env helpers ───────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

async function upstashGet<T>(url: string, token: string, key: string): Promise<T | null> {
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Upstash GET ${key} failed: ${r.status}`);
  const body = await r.json() as { result: string | null };
  return body.result ? (JSON.parse(body.result) as T) : null;
}

async function upstashSet(url: string, token: string, key: string, value: unknown): Promise<void> {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Upstash SET ${key} failed: ${r.status}`);
}

// ── Client wiring ─────────────────────────────────────────────────

function buildDeps() {
  const upstashUrl = requireEnv('UPSTASH_REDIS_REST_URL');
  const upstashToken = requireEnv('UPSTASH_REDIS_REST_TOKEN');
  const pd = new PipedriveClient({
    apiKey: requireEnv('PIPEDRIVE_API_KEY'),
    companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
    systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
    dealSpine: {
      pipelineId: DEAL_PIPELINE_ID,
      stageIds: DEAL_STAGE_IDS,
      fieldHashes: DEAL_FIELD_HASHES,
    },
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: () => upstashGet<QBOAuthTokens>(upstashUrl, upstashToken, keys.qbOAuthTokens),
    saveTokens: (tokens) => upstashSet(upstashUrl, upstashToken, keys.qbOAuthTokens, tokens),
  });
  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
    webhookSecret: process.env.QUO_WEBHOOK_SECRET ?? '',
  });
  const cal = new GoogleCalendarClient({
    calendarId: requireEnv('GOOGLE_CALENDAR_ID'),
    oauth: {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
    },
  });
  return { pd, qb, quo, cal, newId: () => randomUUID(), now: () => new Date() };
}

// ── Output ────────────────────────────────────────────────────────

function renderMarkdown(rows: BacktestRow[], summary: BacktestSummary, args: Args): string {
  const header = [
    '# Scheduling Backtest',
    '',
    `Window: \`${args.from.toISOString()}\` → \`${args.to.toISOString()}\``,
    args.phone ? `Phone filter: \`${args.phone}\`` : 'Phone filter: (none)',
    `Match window: ${args.matchWindowDays}d after acceptance`,
    '',
    '## Summary',
    '',
    `- Rows: **${summary.rowCount}**`,
    `- Positive matches: **${summary.positiveMatches}**`,
    `- Directive but no event found: ${summary.directivesWithNoEvent}`,
    `- Event but no directive (classifier miss): ${summary.eventsWithNoDirective}`,
    `- Filtered out: ${summary.filteredOut}`,
    `- Agreement rate: **${(summary.agreementRate * 100).toFixed(1)}%**`,
    '',
    '## Rows',
    '',
    '| Accepted at | Customer | QB Est | Directive score | Verdict | Notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const score = r.directive?.confidence.score.toFixed(2) ?? '—';
    const accepted = r.timestamp.slice(0, 16).replace('T', ' ');
    header.push(
      `| ${accepted} | ${r.customerName} | ${r.qbEstimateId ?? '—'} | ${score} | ${r.verdict} | ${r.notes} |`,
    );
  }
  return header.join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const deps = buildDeps();
  const { rows, summary } = await replayQbApprovals(deps, {
    from: args.from,
    to: args.to,
    phone: args.phone,
    matchWindowDays: args.matchWindowDays,
  });
  process.stdout.write(renderMarkdown(rows, summary, args));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
