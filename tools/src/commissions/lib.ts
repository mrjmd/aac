/**
 * Shared config + helpers for the Ed commission report.
 * See docs/projects/ed-commission-report.md.
 */
import fs from 'node:fs';
import path from 'node:path';

// ── attribution config ───────────────────────────────────────────────

/** Pipedrive person custom-field hashes (from /personFields). */
export const REF_FIELD = '34e9bd78a631d8950b507a722c4e245a9ef9de11'; // "Referred by" (people)
export const QB_FIELD = 'a02e76a3d2d7e38cacd476aaea1c2a8809264025'; // "QB Customer ID"

/** Edward Crowell: PD person (as a referrer) and PD user (as an owner). */
export const ED_PERSON_ID = 5225;
export const ED_USER_ID = 24313124;

/** Known test records that carry the Referred-by tag but aren't real leads. */
export const EXCLUDE_PERSON_IDS = new Set([5266, 5272]); // Test CLI, Matt Testing

/** Commission rate on the invoice total of a fully-paid job. */
export const COMMISSION_RATE = 0.2;

export const DATA_DIR = 'analysis/data/commissions';
export const MANUAL_LINKS_PATH = `${DATA_DIR}/manual-links.json`;
export const SNAPSHOT_PATH = `${DATA_DIR}/snapshot.json`;
export const FINDINGS_PATH = `${DATA_DIR}/findings.json`;
export const LEDGER_PATH = `${DATA_DIR}/ledger.json`;
export const REPORT_PATH = 'analysis/commissions.html';
export const EMAIL_PATH = `${DATA_DIR}/email.md`;

// ── env ──────────────────────────────────────────────────────────────

export function loadEnv(): void {
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

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

// ── shared shapes ────────────────────────────────────────────────────

export interface SlimPerson {
  id: number;
  name: string;
  ownerId: number | null;
  referredById: number | null;
  referredByName: string | null;
  qbCustomerId: string | null;
  phones: string[];
  addTime: string;
}

export interface SlimDeal {
  id: number;
  personId: number | null;
  title: string;
  status: string;
  value: number;
  qbEstimateId: string | null;
  addTime: string;
}

export interface Snapshot {
  runAt: string;
  persons: SlimPerson[];
  deals: SlimDeal[];
  invoices: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  estimates: Array<Record<string, unknown>>;
}

export interface CommissionEvent {
  personId: number;
  personName: string;
  reason: string;
  qbCustomerId: string;
  invoiceId: string;
  invoiceDocNumber: string;
  invoiceDate: string;
  invoiceAmount: number;
  paidDate: string;
  commission: number;
  /** true when this commission is already in the ledger (paid to Ed via payroll). */
  paidToEd: boolean;
}

/** Job invoiced but customer hasn't paid yet — commission on its way. */
export interface PendingInvoice {
  personId: number;
  personName: string;
  reason: string;
  invoiceDocNumber: string;
  invoiceDate: string;
  amount: number;
  balance: number;
  commission: number;
}

/** Open quote — commission potential if the deal closes. */
export interface OpenEstimate {
  personId: number;
  personName: string;
  reason: string;
  estimateDocNumber: string;
  estimateDate: string;
  status: string;
  amount: number;
  commission: number;
}

export interface Findings {
  runAt: string;
  rate: number;
  attributedCount: number;
  events: CommissionEvent[];
  pendingInvoices: PendingInvoice[];
  openEstimates: OpenEstimate[];
  roster: Array<{ personId: number; personName: string; reason: string }>;
}

/**
 * Local patch linking a PD person to an (additional) QB customer the PD
 * QB Customer ID field doesn't capture — without writing to Pipedrive (PD
 * custom field writes fire the middleware webhook). Also covers people who
 * bill under a second QBO customer (e.g. Tom Dacey ↔ Champion Builders).
 * `effectiveFrom` (ISO date) excludes that customer's transactions before
 * the date — used when a QBO customer predates Ed's involvement.
 */
export interface ManualLink {
  personId: number;
  qbCustomerId: string;
  note: string;
  effectiveFrom?: string;
}

/** One ledger entry = one commission actually paid out to Ed via payroll. */
export interface LedgerEntry {
  invoiceId: string;
  invoiceDocNumber: string;
  personName: string;
  invoiceAmount: number;
  commission: number;
  paidDate: string;
  paidAt: string;
  note?: string;
}
