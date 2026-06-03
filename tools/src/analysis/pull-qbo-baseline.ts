#!/usr/bin/env npx tsx
/**
 * Pull a comprehensive QuickBooks Online baseline snapshot for the
 * AAC business diagnostic. Dumps reports + entities as JSON under
 * analysis/data/qbo/ for offline analysis.
 *
 * Usage:
 *   npx tsx tools/src/analysis/pull-qbo-baseline.ts
 *
 * Credentials are loaded from .env.diagnostic (project root). OAuth tokens
 * are read from Upstash via REST; if a refresh happens the new tokens are
 * written back so the middleware stays in sync (Intuit invalidates the old
 * refresh_token on each refresh — we MUST persist).
 */

import fs from 'node:fs';
import path from 'node:path';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
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

// ── Upstash via REST (mirrors @upstash/redis SDK serialization) ──────

async function upstashGet<T>(url: string, token: string, key: string): Promise<T | null> {
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Upstash GET ${key} failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { result: string | null };
  if (body.result === null) return null;
  return JSON.parse(body.result) as T;
}

async function upstashSet(url: string, token: string, key: string, value: unknown): Promise<void> {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Upstash SET ${key} failed: ${r.status} ${await r.text()}`);
  // Also write a local backup of the token state in case the in-flight
  // refresh races with a middleware QB call.
  const backupDir = path.resolve(process.cwd(), 'analysis/data/qbo/.token-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `${stamp}.json`), JSON.stringify(value, null, 2));
}

// ── QB client wiring ────────────────────────────────────────────────

function makeClient(): QuickBooksClient {
  const upstashUrl = requireEnv('UPSTASH_REDIS_REST_URL');
  const upstashToken = requireEnv('UPSTASH_REDIS_REST_TOKEN');
  return new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: () => upstashGet<QBOAuthTokens>(upstashUrl, upstashToken, keys.qbOAuthTokens),
    saveTokens: (tokens) => upstashSet(upstashUrl, upstashToken, keys.qbOAuthTokens, tokens),
  });
}

// ── Pull helpers ────────────────────────────────────────────────────

interface PageResponse<T> {
  QueryResponse?: Record<string, T[] | number | undefined>;
}

async function fetchAllPages<T>(client: QuickBooksClient, entity: string): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 1000;
  let start = 1;
  for (;;) {
    const sql = `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const res = await client.query<PageResponse<T>>(sql);
    const rows = (res.QueryResponse?.[entity] as T[] | undefined) ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

interface FileInfo {
  name: string;
  bytes: number;
  count?: number;
}

function writeJson(outDir: string, name: string, data: unknown): FileInfo {
  const filePath = path.join(outDir, name);
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json);
  return {
    name,
    bytes: json.length,
    count: Array.isArray(data) ? data.length : undefined,
  };
}

// ── main ────────────────────────────────────────────────────────────

interface ManifestEntry {
  kind: 'report' | 'entity';
  name: string;
  params?: Record<string, string>;
  file?: string;
  bytes?: number;
  count?: number;
  error?: string;
}

async function main(): Promise<void> {
  loadEnv();
  const client = makeClient();

  const projectRoot = process.cwd();
  const outDir = path.resolve(projectRoot, 'analysis/data/qbo');
  fs.mkdirSync(outDir, { recursive: true });

  // "As-of" date for all period end-dates. Defaults to today, but can be
  // overridden via the first CLI arg or QBO_AS_OF env (YYYY-MM-DD) to pull a
  // clean period boundary — e.g. month-end — instead of a mid-month snapshot.
  const asOfOverride = process.argv[2] ?? process.env.QBO_AS_OF;
  if (asOfOverride && !/^\d{4}-\d{2}-\d{2}$/.test(asOfOverride)) {
    throw new Error(`Invalid as-of date "${asOfOverride}" — expected YYYY-MM-DD`);
  }
  const today = asOfOverride ?? new Date().toISOString().slice(0, 10);
  const startDate = '2024-09-01';
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const priorYear = String(parseInt(today.slice(0, 4), 10) - 1);
  const priorYearStart = `${priorYear}-01-01`;
  const priorYearToday = `${priorYear}${today.slice(4)}`; // same MM-DD, prior year

  const manifest: {
    runAt: string;
    period: { start: string; end: string };
    realmId: string;
    files: ManifestEntry[];
  } = {
    runAt: new Date().toISOString(),
    period: { start: startDate, end: today },
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    files: [],
  };

  console.log('QBO baseline pull starting');
  console.log(`  realm: ${manifest.realmId}`);
  console.log(`  range: ${startDate} → ${today}`);
  console.log(`  out:   ${outDir}\n`);

  const reports: Array<{ file: string; name: string; params: Record<string, string> }> = [
    { file: 'pnl-monthly-accrual.json', name: 'ProfitAndLoss',
      params: { start_date: startDate, end_date: today, summarize_column_by: 'Month', accounting_method: 'Accrual' } },
    { file: 'pnl-monthly-cash.json', name: 'ProfitAndLoss',
      params: { start_date: startDate, end_date: today, summarize_column_by: 'Month', accounting_method: 'Cash' } },
    { file: 'pnl-ytd-accrual.json', name: 'ProfitAndLoss',
      params: { start_date: yearStart, end_date: today, accounting_method: 'Accrual' } },
    { file: 'pnl-prior-ytd-accrual.json', name: 'ProfitAndLoss',
      params: { start_date: priorYearStart, end_date: priorYearToday, accounting_method: 'Accrual' } },
    { file: 'pnl-total-accrual.json', name: 'ProfitAndLoss',
      params: { start_date: startDate, end_date: today, accounting_method: 'Accrual' } },
    { file: 'pnl-total-cash.json', name: 'ProfitAndLoss',
      params: { start_date: startDate, end_date: today, accounting_method: 'Cash' } },
    { file: 'pnl-detail-2025.json', name: 'ProfitAndLossDetail',
      params: { start_date: '2025-01-01', end_date: '2025-12-31', accounting_method: 'Accrual' } },
    { file: 'pnl-detail-ytd.json', name: 'ProfitAndLossDetail',
      params: { start_date: yearStart, end_date: today, accounting_method: 'Accrual' } },
    { file: 'balance-sheet.json', name: 'BalanceSheet',
      params: { end_date: today } },
    { file: 'cash-flow.json', name: 'CashFlow',
      params: { start_date: startDate, end_date: today } },
    { file: 'customer-income.json', name: 'CustomerIncome',
      params: { start_date: startDate, end_date: today } },
    { file: 'customer-sales.json', name: 'CustomerSales',
      params: { start_date: startDate, end_date: today, summarize_column_by: 'Customers' } },
    { file: 'item-sales.json', name: 'ItemSales',
      params: { start_date: startDate, end_date: today } },
    { file: 'aged-receivables.json', name: 'AgedReceivables', params: {} },
    { file: 'aged-payables.json', name: 'AgedPayables', params: {} },
    { file: 'transaction-list.json', name: 'TransactionList',
      params: { start_date: startDate, end_date: today } },
    { file: 'general-ledger-ytd.json', name: 'GeneralLedger',
      params: { start_date: yearStart, end_date: today } },
  ];

  for (const r of reports) {
    process.stdout.write(`  report ${r.name.padEnd(22)} → ${r.file.padEnd(34)} `);
    try {
      const data = await client.report(r.name, r.params);
      const info = writeJson(outDir, r.file, data);
      manifest.files.push({ kind: 'report', name: r.name, params: r.params, file: info.name, bytes: info.bytes });
      console.log(`${info.bytes.toLocaleString()} bytes`);
    } catch (err) {
      console.log('FAILED');
      console.log(`    ${(err as Error).message}`);
      manifest.files.push({ kind: 'report', name: r.name, params: r.params, error: (err as Error).message });
    }
  }

  console.log();

  const entities = [
    'Customer', 'Item', 'Invoice', 'Payment', 'Vendor', 'Account',
    'Bill', 'BillPayment', 'Purchase', 'Estimate', 'Deposit',
    'CreditMemo', 'JournalEntry', 'Transfer', 'Employee',
  ];
  for (const entity of entities) {
    process.stdout.write(`  entity ${entity.padEnd(22)} `);
    try {
      const rows = await fetchAllPages<unknown>(client, entity);
      const info = writeJson(outDir, `entity-${entity.toLowerCase()}.json`, rows);
      manifest.files.push({ kind: 'entity', name: entity, file: info.name, bytes: info.bytes, count: rows.length });
      console.log(`${rows.length.toString().padStart(5)} rows, ${info.bytes.toLocaleString()} bytes`);
    } catch (err) {
      console.log('FAILED');
      console.log(`    ${(err as Error).message}`);
      manifest.files.push({ kind: 'entity', name: entity, error: (err as Error).message });
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${path.join(outDir, 'manifest.json')}`);
  console.log(`Files written: ${manifest.files.filter((f) => !f.error).length} ok, ${manifest.files.filter((f) => f.error).length} failed`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
