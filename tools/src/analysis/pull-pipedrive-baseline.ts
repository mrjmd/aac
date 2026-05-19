#!/usr/bin/env npx tsx
/**
 * Pull comprehensive Pipedrive baseline for the AAC demand diagnostic.
 *
 * Focus: salesperson attribution. Pulls deals + custom fields (incl. "referred
 * by"), users, persons, activities, leads, pipelines/stages. Dumps JSON to
 * analysis/data/pipedrive/ for offline analysis.
 *
 * Usage:
 *   npx tsx tools/src/analysis/pull-pipedrive-baseline.ts
 *
 * Credentials loaded from .env.diagnostic (project root).
 */

import fs from 'node:fs';
import path from 'node:path';
import { PipedriveClient } from '@aac/api-clients/pipedrive';

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

function makeClient(): PipedriveClient {
  return new PipedriveClient({
    apiKey: requireEnv('PIPEDRIVE_API_KEY'),
    companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
    systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
  });
}

async function fetchAllPages<T>(
  client: PipedriveClient,
  endpoint: string,
  extraParams: Record<string, string | number> = {}
): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 500;
  let start = 0;
  for (;;) {
    const res = await client.rawGet<T[]>(endpoint, { ...extraParams, start, limit: pageSize });
    const rows = (res.data ?? []) as T[];
    if (rows.length === 0) break;
    all.push(...rows);
    const more = res.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    const nextStart = res.additional_data?.pagination?.next_start;
    if (nextStart === undefined || nextStart <= start) break;
    start = nextStart;
  }
  return all;
}

interface FileInfo { name: string; bytes: number; count?: number }

function writeJson(outDir: string, name: string, data: unknown): FileInfo {
  const filePath = path.join(outDir, name);
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json);
  return { name, bytes: json.length, count: Array.isArray(data) ? data.length : undefined };
}

interface Manifest {
  runAt: string;
  files: Array<{ kind: string; endpoint: string; file?: string; bytes?: number; count?: number; error?: string }>;
}

async function main(): Promise<void> {
  loadEnv();
  const client = makeClient();
  const outDir = path.resolve(process.cwd(), 'analysis/data/pipedrive');
  fs.mkdirSync(outDir, { recursive: true });

  const manifest: Manifest = { runAt: new Date().toISOString(), files: [] };

  console.log('Pipedrive baseline pull starting');
  console.log(`  domain: ${process.env.PIPEDRIVE_COMPANY_DOMAIN}`);
  console.log(`  out:    ${outDir}\n`);

  // ── Metadata: fields, users, pipelines, stages ──────────────────
  const metadataEndpoints: Array<{ file: string; endpoint: string }> = [
    { file: 'meta-deal-fields.json', endpoint: '/dealFields' },
    { file: 'meta-person-fields.json', endpoint: '/personFields' },
    { file: 'meta-organization-fields.json', endpoint: '/organizationFields' },
    { file: 'meta-lead-labels.json', endpoint: '/leadLabels' },
    { file: 'meta-users.json', endpoint: '/users' },
    { file: 'meta-pipelines.json', endpoint: '/pipelines' },
    { file: 'meta-stages.json', endpoint: '/stages' },
    { file: 'meta-activity-types.json', endpoint: '/activityTypes' },
    { file: 'meta-deal-statuses.json', endpoint: '/dealFields/find?name=Status' },
  ];

  for (const m of metadataEndpoints) {
    process.stdout.write(`  meta   ${m.endpoint.padEnd(34)} `);
    try {
      const res = await client.rawGet(m.endpoint);
      const info = writeJson(outDir, m.file, res.data);
      manifest.files.push({ kind: 'meta', endpoint: m.endpoint, file: info.name, bytes: info.bytes, count: info.count });
      console.log(`${(info.count ?? '—').toString().padStart(5)} items, ${info.bytes.toLocaleString()} bytes`);
    } catch (err) {
      console.log('FAILED');
      console.log(`    ${(err as Error).message}`);
      manifest.files.push({ kind: 'meta', endpoint: m.endpoint, error: (err as Error).message });
    }
  }

  console.log();

  // ── Paginated entity dumps ──────────────────────────────────────
  const entityEndpoints: Array<{ file: string; endpoint: string; params?: Record<string, string | number> }> = [
    { file: 'deals-all.json', endpoint: '/deals', params: { status: 'all_not_deleted' } },
    { file: 'persons-all.json', endpoint: '/persons' },
    { file: 'organizations-all.json', endpoint: '/organizations' },
    { file: 'activities-all.json', endpoint: '/activities', params: { user_id: 0 } }, // user_id=0 means all users
    { file: 'notes-all.json', endpoint: '/notes' },
    { file: 'leads-all.json', endpoint: '/leads' },
    { file: 'files-all.json', endpoint: '/files' },
  ];

  for (const e of entityEndpoints) {
    process.stdout.write(`  entity ${e.endpoint.padEnd(34)} `);
    try {
      const rows = await fetchAllPages<unknown>(client, e.endpoint, e.params ?? {});
      const info = writeJson(outDir, e.file, rows);
      manifest.files.push({ kind: 'entity', endpoint: e.endpoint, file: info.name, bytes: info.bytes, count: rows.length });
      console.log(`${rows.length.toString().padStart(5)} rows, ${info.bytes.toLocaleString()} bytes`);
    } catch (err) {
      console.log('FAILED');
      console.log(`    ${(err as Error).message}`);
      manifest.files.push({ kind: 'entity', endpoint: e.endpoint, error: (err as Error).message });
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${path.join(outDir, 'manifest.json')}`);
  console.log(`Files: ${manifest.files.filter((f) => !f.error).length} ok, ${manifest.files.filter((f) => f.error).length} failed`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
