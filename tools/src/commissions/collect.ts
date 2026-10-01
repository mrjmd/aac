#!/usr/bin/env npx tsx
/**
 * Ed commission report — data collection.
 *
 * Pulls Pipedrive persons + deals (attribution fields) and QBO invoices +
 * payments into analysis/data/commissions/snapshot.json.
 * Run from repo root. Creds from .env.diagnostic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { PipedriveClient, DEAL_FIELD_HASHES } from '@aac/api-clients/pipedrive';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { keys } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import {
  loadEnv, requireEnv, writeJson, REF_FIELD, QB_FIELD, SNAPSHOT_PATH, DATA_DIR,
  type SlimPerson, type SlimDeal, type Snapshot,
} from './lib';

async function fetchAllPages<T>(
  client: PipedriveClient,
  endpoint: string,
  extraParams: Record<string, string | number> = {},
): Promise<T[]> {
  const all: T[] = [];
  let start = 0;
  for (;;) {
    const res = await client.rawGet<T[]>(endpoint, { ...extraParams, start, limit: 500 });
    all.push(...(res.data ?? []));
    const more = res.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    const nextStart = res.additional_data?.pagination?.next_start;
    if (nextStart === undefined || nextStart <= start) break;
    start = nextStart;
  }
  return all;
}

async function qboFetchAll(
  client: QuickBooksClient,
  entity: 'Invoice' | 'Payment' | 'Estimate',
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  let start = 1;
  for (;;) {
    const sql = `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const res = await client.query<{ QueryResponse?: Record<string, unknown> }>(sql);
    const rows = (res.QueryResponse?.[entity] as Array<Record<string, unknown>> | undefined) ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

function slimPerson(p: Record<string, any>): SlimPerson {
  const ref = p[REF_FIELD];
  const owner = p.owner_id;
  return {
    id: p.id,
    name: p.name ?? '',
    ownerId: typeof owner === 'object' && owner ? owner.id : owner ?? null,
    referredById: typeof ref === 'object' && ref ? Number(ref.value ?? ref.id) : ref ? Number(ref) : null,
    referredByName: typeof ref === 'object' && ref ? ref.name ?? null : null,
    qbCustomerId: p[QB_FIELD] != null ? String(p[QB_FIELD]) : null,
    phones: ((p.phone as Array<{ value?: string }>) ?? []).map((ph) => ph.value ?? '').filter(Boolean),
    addTime: p.add_time ?? '',
  };
}

const DEAL_QB_ESTIMATE_FIELD = DEAL_FIELD_HASHES.qbEstimateId;

function slimDeal(d: Record<string, any>): SlimDeal {
  const pid = d.person_id;
  return {
    id: d.id,
    personId: typeof pid === 'object' && pid ? pid.value ?? null : pid ?? null,
    title: d.title ?? '',
    status: d.status ?? '',
    value: typeof d.value === 'number' ? d.value : 0,
    qbEstimateId: d[DEAL_QB_ESTIMATE_FIELD] != null ? String(d[DEAL_QB_ESTIMATE_FIELD]) : null,
    addTime: d.add_time ?? '',
  };
}

async function main(): Promise<void> {
  loadEnv();
  fs.mkdirSync(path.resolve(process.cwd(), DATA_DIR), { recursive: true });

  const pd = new PipedriveClient({
    apiKey: requireEnv('PIPEDRIVE_API_KEY'),
    companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
    systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
  });

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
      const backupDir = path.join(DATA_DIR, '.token-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(backupDir, `${stamp}.json`), JSON.stringify(tokens, null, 2));
    },
  });

  console.log('Pulling Pipedrive persons…');
  const persons = (await fetchAllPages<Record<string, any>>(pd, '/persons')).map(slimPerson);
  console.log(`  ${persons.length} persons`);

  console.log('Pulling Pipedrive deals…');
  const deals = (await fetchAllPages<Record<string, any>>(pd, '/deals', { status: 'all_not_deleted' })).map(slimDeal);
  console.log(`  ${deals.length} deals`);

  console.log('Pulling QBO invoices…');
  const invoices = await qboFetchAll(qb, 'Invoice');
  console.log(`  ${invoices.length} invoices`);

  console.log('Pulling QBO payments…');
  const payments = await qboFetchAll(qb, 'Payment');
  console.log(`  ${payments.length} payments`);

  console.log('Pulling QBO estimates…');
  const estimates = await qboFetchAll(qb, 'Estimate');
  console.log(`  ${estimates.length} estimates`);

  const snapshot: Snapshot = { runAt: new Date().toISOString(), persons, deals, invoices, payments, estimates };
  writeJson(SNAPSHOT_PATH, snapshot);
  console.log(`Snapshot -> ${SNAPSHOT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
