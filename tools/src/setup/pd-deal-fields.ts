#!/usr/bin/env npx tsx
/**
 * One-shot setup script for the PD Deal custom fields that the deal spine
 * needs. Idempotent — checks for existence first, only creates what's
 * missing. Safe to re-run.
 *
 * Fields created on the Deal entity:
 *   - qb_estimate_id (text)   QB Estimate.Id for this opportunity (1:1)
 *   - qb_invoice_id  (text)   QB Invoice.Id for this opportunity (1:1)
 *   - external_id    (text)   Generic dedup key for backfill/idempotency
 *   - lost_reason    (enum)   Loss disposition
 *
 * Output: prints a TypeScript constants block at the end, ready to paste
 * into `packages/api-clients/src/pipedrive.ts` as `DEAL_FIELD_HASHES`.
 *
 * Calendar events do NOT get a deal-side foreign key — they link to deals
 * via the `[deal:N]` marker in the event description. See
 * `docs/projects/apps-agent.md` → "Deal model".
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envText = readFileSync(resolve(__dirname, '../../../.env.diagnostic'), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const PD_KEY = process.env.PIPEDRIVE_API_KEY;
if (!PD_KEY) {
  console.error('Missing PIPEDRIVE_API_KEY in env');
  process.exit(1);
}

// Match the PipedriveClient pattern: hit api.pipedrive.com directly with
// api_token as a query param. PD also exposes a {domain}.pipedrive.com
// variant but the api.* host is what the client uses and what works
// reliably from this sandbox.
const BASE = 'https://api.pipedrive.com/v1';

interface PdDealField {
  id: number;
  key: string;
  name: string;
  field_type: string;
  options?: Array<{ id: number; label: string }>;
}

interface PdResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

async function pdGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${PD_KEY}`);
  const json = (await res.json()) as PdResponse<T>;
  if (!json.success) throw new Error(`PD GET ${path} failed: ${json.error}`);
  return json.data;
}

async function pdPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}?api_token=${PD_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as PdResponse<T>;
  if (!json.success) throw new Error(`PD POST ${path} failed: ${json.error ?? JSON.stringify(json)}`);
  return json.data;
}

// Field definitions. Names are what shows up in the PD UI; the script
// matches existing fields by name to keep this idempotent.
const FIELD_DEFS = [
  {
    constName: 'qbEstimateId',
    name: 'QB Estimate ID',
    field_type: 'varchar',
  },
  {
    constName: 'qbInvoiceId',
    name: 'QB Invoice ID',
    field_type: 'varchar',
  },
  {
    constName: 'externalId',
    name: 'External ID',
    field_type: 'varchar',
  },
  {
    // Stored as a free-text field rather than a PD enum so the code-side
    // `LostReason` union is the single source of truth and we don't need
    // to round-trip through PD option IDs. Allowed values are enforced at
    // the client layer (PipedriveClient.markDealLost).
    constName: 'lostReason',
    name: 'Lost Reason',
    field_type: 'varchar',
  },
] as const;

async function main(): Promise<void> {
  console.log('Connecting to api.pipedrive.com…');
  const existing = await pdGet<PdDealField[]>('/dealFields');
  console.log(`Found ${existing.length} existing deal fields.\n`);

  const result: Record<string, string> = {};

  for (const def of FIELD_DEFS) {
    const found = existing.find((f) => f.name === def.name);
    if (found) {
      console.log(`  ✓ "${def.name}" already exists (key=${found.key})`);
      result[def.constName] = found.key;
      continue;
    }

    const body: Record<string, unknown> = {
      name: def.name,
      field_type: def.field_type,
    };
    if ('options' in def && def.options) {
      body.options = def.options.map((label) => ({ label }));
    }

    const created = await pdPost<PdDealField>('/dealFields', body);
    console.log(`  + Created "${def.name}" (key=${created.key})`);
    result[def.constName] = created.key;
  }

  console.log('\n--- Paste this into packages/api-clients/src/pipedrive.ts ---\n');
  console.log('export const DEAL_FIELD_HASHES = {');
  for (const [k, v] of Object.entries(result)) {
    console.log(`  ${k}: '${v}',`);
  }
  console.log('} as const;');
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
