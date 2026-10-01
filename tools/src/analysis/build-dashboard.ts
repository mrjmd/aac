#!/usr/bin/env npx tsx
/**
 * Build a self-contained HTML dashboard from the QBO baseline dumps.
 *
 * Reads:   analysis/data/qbo/*.json
 * Writes:  analysis/dashboard.html
 *
 * The HTML embeds all chart data inline as a JS constant + pulls Chart.js
 * from CDN, so it works as a file:// double-click — no local server needed.
 *
 * Usage:
 *   npx tsx tools/src/analysis/build-dashboard.ts
 */

import fs from 'node:fs';
import path from 'node:path';

// ── QB report parsing helpers ────────────────────────────────────────

interface QBRow {
  ColData?: Array<{ value: string }>;
  Rows?: { Row: QBRow[] };
  Summary?: { ColData: Array<{ value: string }> };
  type?: string;
  group?: string;
}

interface QBNamedRow extends QBRow {
  group?: string;
}

interface QBReport {
  Header?: { StartPeriod?: string; EndPeriod?: string };
  Columns?: { Column: Array<{ ColTitle: string }> };
  Rows?: { Row: QBRow[] };
}

function findRow(rows: QBRow[] | undefined, labelMatch: string): Array<{ value: string }> | null {
  if (!rows) return null;
  for (const r of rows) {
    const cd = r.ColData;
    if (cd && cd[0]?.value.toLowerCase().includes(labelMatch.toLowerCase())) return cd;
    if (r.Rows) {
      const found = findRow(r.Rows.Row, labelMatch);
      if (found) return found;
    }
    if (r.Summary?.ColData[0]?.value.toLowerCase().includes(labelMatch.toLowerCase())) {
      return r.Summary.ColData;
    }
  }
  return null;
}

function num(s: string | undefined): number {
  return parseFloat(s ?? '0') || 0;
}

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

// ── OpEx detail helpers ──────────────────────────────────────────────

interface BankTxn { postedDate: string; monthKey: string; category: string; amount: number; description: string; rawDescription: string; }

/** Normalize a merchant key — collapse account numbers and store codes so
 *  "FACEBK *XZUJJN8J32 Menlo Par CA" and "FACEBK *7X6SPLUH32 Menlo Par CA"
 *  both bucket as "facebk menlo par ca". Used as the recurring-detection key. */
function merchantKey(t: BankTxn): string {
  const src = (t.description || t.rawDescription).toLowerCase();
  return src
    .replace(/\*[a-z0-9]+/g, '')         // *XXXX merchant codes
    .replace(/#\d+/g, '')                  // store numbers
    .replace(/\b\d{6,}\b/g, '')            // long numeric ids
    .replace(/\bterminal \d+\b/g, '')
    .replace(/\bpos purchase\b/g, '')
    .replace(/\bmerchant purchase\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** Coefficient of variation — stdev/mean. Subscriptions have low CV. */
function cv(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  if (m === 0) return 0;
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance) / Math.abs(m);
}

/** Two months between two YYYY-MM strings. */
function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** Bucket a merchant key into the variable-spend category we want to chart. */
function variableBucket(category: string): string | null {
  if (category === 'Vehicle (Fuel)') return 'Vehicle (Fuel)';
  if (category === 'Vehicle (Maintenance)') return 'Vehicle (Maintenance)';
  if (category === 'Vehicle (Tolls)') return 'Vehicle (Tolls)';
  if (category === 'Vehicle (Parking)') return 'Vehicle (Parking)';
  if (category === 'Materials (Hardware Store)') return 'Materials (Hardware Store)';
  if (category === 'Materials (Specialty)') return 'Materials (Specialty)';
  if (category === 'Meals') return 'Meals';
  if (category === 'Office / Supplies') return 'Office / Supplies';
  return null;
}

/** Cadence heuristic: hits-per-month spacing vs. monthly. */
function detectCadence(monthKeys: string[]): 'monthly' | 'quarterly' | 'annual' | 'irregular' {
  if (monthKeys.length < 2) return 'irregular';
  const sorted = [...new Set(monthKeys)].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(monthDiff(sorted[i - 1], sorted[i]));
  const med = median(gaps);
  if (med <= 1.5) return 'monthly';
  if (med <= 4) return 'quarterly';
  if (med <= 13) return 'annual';
  return 'irregular';
}

function annualizeFromCadence(monthlyAvg: number, cadence: string): number {
  // monthlyAvg is the per-occurrence amount; convert to annual via cadence
  if (cadence === 'monthly') return monthlyAvg * 12;
  if (cadence === 'quarterly') return monthlyAvg * 4;
  if (cadence === 'annual') return monthlyAvg;
  return monthlyAvg * 6; // irregular — assume ~2x/yr as a rough proxy
}

interface RecurringRow {
  merchant: string;
  category: string;
  cadence: 'monthly' | 'quarterly' | 'annual' | 'irregular';
  avgAmount: number;
  monthlyEquivalent: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  stillActive: boolean;
  annualizedSpend: number;
  sampleRaw: string;
}

/** Subscription/recurring detection: outflow merchants with 3+ hits AND low
 *  CV (same-ish amount each time) OR monthly cadence (consistent spacing). */
function detectRecurring(txns: BankTxn[], periodEndMonth: string): RecurringRow[] {
  // Skip categories that are inherently lumpy or revenue
  const skipCategories = new Set([
    'Materials (Hardware Store)',
    'Materials (Specialty)',
    'Vehicle (Fuel)',
    'Vehicle (Maintenance)',
    'Vehicle (Tolls)',
    'Vehicle (Parking)',
    'Vehicle (Rental)',
    'Cash / Check (manual review)',
    'Possible Contract Labor (P2P)',
    'Payroll (Wages Impound)',
    'Payroll (Taxes)',
    'Payroll (Processing Fees)',
    'Internal Transfer',
    'Payment Processing',
    'Meals',
    'UNCATEGORIZED',
  ]);

  const outflows = txns.filter((t) => t.amount < 0 && !skipCategories.has(t.category));
  const groups = new Map<string, BankTxn[]>();
  for (const t of outflows) {
    const k = merchantKey(t);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }

  const recurring: RecurringRow[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const amounts = list.map((t) => Math.abs(t.amount));
    const months = list.map((t) => t.monthKey);
    const c = cv(amounts);
    const cadence = detectCadence(months);

    // Acceptance: at least 3 hits OR (2 hits AND low CV monthly), to catch
    // brand-new subscriptions that only have 2 charges so far.
    const qualifies =
      (list.length >= 3) ||
      (list.length === 2 && c < 0.15 && cadence === 'monthly');
    if (!qualifies) continue;

    // Skip "noisy" merchants where amounts vary wildly — those aren't
    // subscriptions, they're ad-hoc spend bunched under the same name.
    if (c > 0.6 && list.length < 6) continue;

    const sorted = [...list].sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    const firstSeen = sorted[0].postedDate.slice(0, 10);
    const lastSeen = sorted[sorted.length - 1].postedDate.slice(0, 10);
    const lastMonth = sorted[sorted.length - 1].monthKey;
    const monthsSinceLast = monthDiff(lastMonth, periodEndMonth);
    // Active if last hit within the cadence window + 1 month grace
    const cadenceWindow =
      cadence === 'monthly' ? 2 : cadence === 'quarterly' ? 5 : cadence === 'annual' ? 14 : 6;
    const stillActive = monthsSinceLast <= cadenceWindow;

    const avgAmount = mean(amounts);
    const monthlyEquivalent =
      cadence === 'monthly' ? avgAmount :
      cadence === 'quarterly' ? avgAmount / 3 :
      cadence === 'annual' ? avgAmount / 12 :
      (avgAmount * list.length) / Math.max(1, monthDiff(sorted[0].monthKey, lastMonth) + 1);

    recurring.push({
      merchant: key.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (l) => l.toUpperCase()),
      category: list[0].category,
      cadence,
      avgAmount,
      monthlyEquivalent,
      occurrences: list.length,
      firstSeen,
      lastSeen,
      stillActive,
      annualizedSpend: annualizeFromCadence(avgAmount, cadence),
      sampleRaw: list[0].rawDescription.slice(0, 80),
    });
  }
  recurring.sort((a, b) => b.annualizedSpend - a.annualizedSpend);
  return recurring;
}

interface VariableBucketRow {
  bucket: string;
  monthlyAvg: number;
  tripCount: number;
  avgPerTrip: number;
  monthlyTrend: number[];
  months: string[];
  topMerchants: Array<{ merchant: string; total: number; count: number }>;
  lastTrip: string;
}

function detectVariable(txns: BankTxn[]): VariableBucketRow[] {
  const outflows = txns.filter((t) => t.amount < 0);
  const months = [...new Set(outflows.map((t) => t.monthKey))].sort();
  const buckets = new Map<string, BankTxn[]>();
  for (const t of outflows) {
    const b = variableBucket(t.category);
    if (!b) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(t);
  }
  const rows: VariableBucketRow[] = [];
  for (const [bucket, list] of buckets) {
    if (list.length === 0) continue;
    const total = list.reduce((s, t) => s + Math.abs(t.amount), 0);
    const monthlyTrend = months.map((m) =>
      list.filter((t) => t.monthKey === m).reduce((s, t) => s + Math.abs(t.amount), 0)
    );
    // Per-merchant breakdown inside the bucket
    const perMerchant = new Map<string, { total: number; count: number }>();
    for (const t of list) {
      const k = merchantKey(t).replace(/\b\w/g, (l) => l.toUpperCase()).trim();
      const cur = perMerchant.get(k) ?? { total: 0, count: 0 };
      cur.total += Math.abs(t.amount);
      cur.count += 1;
      perMerchant.set(k, cur);
    }
    const topMerchants = [...perMerchant.entries()]
      .map(([merchant, v]) => ({ merchant, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
    const sorted = [...list].sort((a, b) => b.postedDate.localeCompare(a.postedDate));
    rows.push({
      bucket,
      monthlyAvg: total / months.length,
      tripCount: list.length,
      avgPerTrip: total / list.length,
      monthlyTrend,
      months,
      topMerchants,
      lastTrip: sorted[0].postedDate.slice(0, 10),
    });
  }
  rows.sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return rows;
}

interface Recommendation {
  kind: 'bulk' | 'consolidate' | 'audit' | 'stop' | 'switch';
  priority: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  estimatedAnnualSavings: number | null;
  evidence: string[];
}

/** Recommendations are derived from the recurring+variable buckets. They're
 *  intentionally specific (named merchants, dollar amounts, dates) so Matt
 *  can act on them without doing the analysis a second time. */
function buildRecommendations(
  recurring: RecurringRow[],
  variable: VariableBucketRow[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  // ── Stop / audit: inactive subscriptions consolidated into one rec
  const inactive = recurring.filter((r) => !r.stillActive && r.annualizedSpend > 100);
  if (inactive.length > 0) {
    const totalIfStillActive = inactive.reduce((s, r) => s + r.annualizedSpend, 0);
    recs.push({
      kind: 'audit',
      priority: 'high',
      title: `${inactive.length} subscriptions stopped charging — confirm they're actually cancelled`,
      detail: `These merchants billed regularly then went quiet. If any are still subscribed (e.g., annual that hasn't renewed yet), they'll re-emerge. Worth a card-statement scan to be sure. Total exposure: $${Math.round(totalIfStillActive).toLocaleString()}/yr.`,
      estimatedAnnualSavings: Math.round(totalIfStillActive * 0.3),
      evidence: inactive
        .sort((a, b) => b.annualizedSpend - a.annualizedSpend)
        .slice(0, 10)
        .map((r) => `${r.merchant}: $${r.avgAmount.toFixed(0)}/${r.cadence}, last ${r.lastSeen} ($${Math.round(r.annualizedSpend)}/yr)`),
    });
  }

  // ── Stop / consolidate: SEO/Marketing tools >$100/mo
  const seoTools = recurring.filter(
    (r) => r.category === 'Marketing (Data/SEO Tools)' && r.stillActive && r.monthlyEquivalent >= 50,
  );
  if (seoTools.length >= 2) {
    const totalAnnual = seoTools.reduce((s, r) => s + r.annualizedSpend, 0);
    recs.push({
      kind: 'consolidate',
      priority: 'high',
      title: `${seoTools.length} active marketing/SEO tools at $${Math.round(totalAnnual)}/yr — audit overlap`,
      detail: `Tools billed monthly that overlap in features. Pick the one with highest active usage and cut the rest. Tools: ${seoTools.map((r) => r.merchant).join(', ')}.`,
      estimatedAnnualSavings: Math.round(totalAnnual * 0.5),
      evidence: seoTools.map((r) => `${r.merchant}: $${r.avgAmount.toFixed(2)}/${r.cadence}, last ${r.lastSeen}`),
    });
  }

  // ── Bulk: hardware store frequency
  const hardware = variable.find((v) => v.bucket === 'Materials (Hardware Store)');
  if (hardware && hardware.tripCount >= 50) {
    const tripsPerMonth = hardware.tripCount / hardware.months.length;
    recs.push({
      kind: 'bulk',
      priority: 'high',
      title: `${tripsPerMonth.toFixed(1)} Home Depot/Lowe's trips per month — consolidate to weekly + Pro account`,
      detail: `${hardware.tripCount} trips totaling $${Math.round(hardware.monthlyAvg * hardware.months.length)}. Avg trip $${hardware.avgPerTrip.toFixed(0)}. Each trip = ~30 min of tech time lost. Home Depot Pro Xtra rewards 2% back on volume; bulk standing orders for fasteners/membrane backer rod save ~10-15%.`,
      estimatedAnnualSavings: Math.round(hardware.monthlyAvg * 12 * 0.12),
      evidence: [
        `Top merchants: ${hardware.topMerchants.map((m) => `${m.merchant} (${m.count}x, $${Math.round(m.total)})`).join(', ')}`,
        `Last trip: ${hardware.lastTrip}`,
      ],
    });
  }

  // ── Fuel: card-share program. Savings are small in $ but bigger benefit
  // is per-vehicle tracking + tax-clean receipts.
  const fuel = variable.find((v) => v.bucket === 'Vehicle (Fuel)');
  if (fuel && fuel.tripCount >= 20) {
    const cumberlandShare = fuel.topMerchants.find((m) => /cumberland/i.test(m.merchant));
    recs.push({
      kind: 'switch',
      priority: 'low',
      title: `Fuel: ${fuel.tripCount} fill-ups across ${fuel.topMerchants.length} stations — push toward one rewards card`,
      detail: `~$${Math.round(fuel.monthlyAvg)}/mo, $${fuel.avgPerTrip.toFixed(0)}/fill. Direct savings are small (~5%), but the real win is per-vehicle tracking + clean tax docs. Cumberland Farms SmartPay (already in Mike's onboarding plan) = 10¢/gal off and is ${cumberlandShare ? 'already ' + Math.round(100 * cumberlandShare.total / fuel.topMerchants.reduce((s,m)=>s+m.total,0)) + '% of fuel spend' : 'a natural fit'}.`,
      estimatedAnnualSavings: Math.round(fuel.monthlyAvg * 12 * 0.05),
      evidence: [
        `Brands: ${fuel.topMerchants.slice(0, 5).map((m) => `${m.merchant} (${m.count}x)`).join(', ')}`,
      ],
    });
  }

  // ── Specialty materials: vendor consolidation
  const specialty = variable.find((v) => v.bucket === 'Materials (Specialty)');
  if (specialty && specialty.topMerchants.length >= 3) {
    recs.push({
      kind: 'bulk',
      priority: 'medium',
      title: `Specialty material orders split across ${specialty.topMerchants.length} vendors — consolidate for volume pricing`,
      detail: `$${Math.round(specialty.monthlyAvg * specialty.months.length)} across ${specialty.tripCount} orders. Concentrating with the largest vendor unlocks 5-10% net 30 discounts. ${specialty.topMerchants[0].merchant} is already $${Math.round(specialty.topMerchants[0].total)} of the volume.`,
      estimatedAnnualSavings: Math.round(specialty.monthlyAvg * 12 * 0.07),
      evidence: specialty.topMerchants.slice(0, 4).map((m) => `${m.merchant}: ${m.count} orders, $${Math.round(m.total)}`),
    });
  }

  // ── High-value active monthly subs — consolidate into one ROI audit
  const highValue = recurring
    .filter((r) => r.stillActive && r.annualizedSpend >= 1500 && r.cadence === 'monthly')
    .filter((r) => !r.category.startsWith('Payroll') && !r.category.startsWith('Insurance'))
    .sort((a, b) => b.annualizedSpend - a.annualizedSpend);
  if (highValue.length > 0) {
    const total = highValue.reduce((s, r) => s + r.annualizedSpend, 0);
    recs.push({
      kind: 'audit',
      priority: 'high',
      title: `Top ${Math.min(highValue.length, 8)} active monthly subscriptions = $${Math.round(total).toLocaleString()}/yr — review ROI`,
      detail: `Each has been billing for months. For each, ask: does the leads/time/revenue it delivers justify the spend? Cut the bottom of the list, keep the top.`,
      estimatedAnnualSavings: null,
      evidence: highValue.slice(0, 8).map((r) =>
        `${r.merchant} — ${r.category} — $${r.avgAmount.toFixed(0)}/mo (~$${Math.round(r.annualizedSpend)}/yr), ${r.occurrences} charges since ${r.firstSeen}`
      ),
    });
  }

  // ── Personal flagged
  const personal = recurring.filter((r) => r.category.startsWith('Personal'));
  for (const r of personal) {
    recs.push({
      kind: 'stop',
      priority: 'high',
      title: `${r.merchant} on the business card`,
      detail: `Categorized as personal. ${r.occurrences} charges, $${Math.round(r.annualizedSpend)}/yr annualized. Should be on personal card for clean books.`,
      estimatedAnnualSavings: null,
      evidence: [r.sampleRaw],
    });
  }

  // Sort: high → medium → low, then by savings within tier
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    (b.estimatedAnnualSavings ?? 0) - (a.estimatedAnnualSavings ?? 0)
  );
  return recs;
}

// ── Dashboard data extraction ────────────────────────────────────────

interface DashboardData {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  headline: {
    revenue: number;
    grossProfit: number;
    netIncome: number;
    trueGrossMarginPct: number;
    cash: number;
    debt: number;
    customers: number;
    invoices: number;
    avgTicket: number;
    closeRatePct: number;
  };
  monthly: Array<{ month: string; revenue: number; cogs: number; opex: number; netIncome: number }>;
  calendarYears: Array<{ year: string; revenue: number; netIncome: number; months: number; complete: boolean }>;
  yoy: Array<{ month: string; y2025: number; y2026: number; growth: number | null }>;
  cumulative: Array<{ month: string; total: number }>;
  topCustomers: Array<{ name: string; total: number; count: number }>;
  quoteFunnel: Array<{ status: string; count: number }>;
  opexCategories: Array<{ category: string; amount: number }>;
  marketing: {
    months: string[];
    series: Array<{ category: string; values: number[]; total: number }>;
    totalSpend: number;
  } | null;
  payrollPaychecks: Array<{ date: string; total: number; tech: number; salesperson: number }> | null;
  opexDetail: {
    /** Period covered by the bank data */
    periodStart: string;
    periodEnd: string;
    monthsCovered: number;
    /** Total non-payroll, non-revenue outflow per month (avg) */
    avgMonthlyOpEx: number;
    /** Recurring spend — subscriptions and monthly fees */
    recurring: Array<{
      merchant: string;
      category: string;
      cadence: 'monthly' | 'quarterly' | 'annual' | 'irregular';
      avgAmount: number;
      monthlyEquivalent: number;
      occurrences: number;
      firstSeen: string;
      lastSeen: string;
      stillActive: boolean;
      annualizedSpend: number;
      sampleRaw: string;
    }>;
    recurringTotal: number;
    recurringAnnualized: number;
    /** Variable / ad-hoc operational spend (gas, hardware store, materials) */
    variable: Array<{
      bucket: string;
      monthlyAvg: number;
      tripCount: number;
      avgPerTrip: number;
      monthlyTrend: number[]; // last N months
      months: string[];
      topMerchants: Array<{ merchant: string; total: number; count: number }>;
      lastTrip: string;
    }>;
    /** AI-flavored recommendations grounded in the transaction data */
    recommendations: Array<{
      kind: 'bulk' | 'consolidate' | 'audit' | 'stop' | 'switch';
      priority: 'high' | 'medium' | 'low';
      title: string;
      detail: string;
      estimatedAnnualSavings: number | null;
      evidence: string[];
    }>;
  } | null;
  ytdCompare: {
    currentYear: number;
    priorYear: number;
    currentRevenue: number;
    priorRevenue: number;
    currentNetIncome: number;
    priorNetIncome: number;
    currentPeriod: { start: string; end: string };
    priorPeriod: { start: string; end: string };
    revenueMultiplier: number | null;
  } | null;
}

function build(dataDir: string): DashboardData {
  const monthlyPnl = loadJson<QBReport>(path.join(dataDir, 'pnl-monthly-accrual.json'));
  const totalPnl = loadJson<QBReport>(path.join(dataDir, 'pnl-total-accrual.json'));
  const balanceSheet = loadJson<QBReport>(path.join(dataDir, 'balance-sheet.json'));
  const invoices = loadJson<Array<{ TotalAmt: number; CustomerRef?: { value: string; name: string } }>>(
    path.join(dataDir, 'entity-invoice.json')
  );
  const customers = loadJson<Array<{ Active?: boolean }>>(path.join(dataDir, 'entity-customer.json'));
  const estimates = loadJson<Array<{ TxnStatus?: string }>>(path.join(dataDir, 'entity-estimate.json'));

  // Headline numbers
  const totalRows = totalPnl.Rows?.Row ?? [];
  const totalRev = num(findRow(totalRows, 'Total Income')?.[1]?.value);
  const totalCogs = num(findRow(totalRows, 'Total Cost of Goods Sold')?.[1]?.value);
  const totalGrossProfit = num(findRow(totalRows, 'Gross Profit')?.[1]?.value);
  const totalNetIncome = num(findRow(totalRows, 'Net Income')?.[1]?.value);
  const wagesAmt = num(findRow(totalRows, 'Wages')?.[1]?.value);
  const payrollAmt = num(findRow(totalRows, 'Total Payroll Expenses')?.[1]?.value);
  const contractLabor = num(findRow(totalRows, 'Contract Labor')?.[1]?.value);
  const trueDirectCosts = totalCogs + payrollAmt + contractLabor;
  const trueGrossMargin = ((totalRev - trueDirectCosts) / totalRev) * 100;
  void wagesAmt;

  const bsRows = balanceSheet.Rows?.Row ?? [];
  const cash = num(findRow(bsRows, 'Total Bank Accounts')?.[1]?.value);
  const debt = num(findRow(bsRows, 'Total Liabilities')?.[1]?.value);

  const invoiceTotals = invoices.map((i) => i.TotalAmt);
  const avgTicket = invoiceTotals.reduce((a, b) => a + b, 0) / invoiceTotals.length;

  const closedSold = estimates.filter((e) => e.TxnStatus === 'Converted' || e.TxnStatus === 'Accepted').length;
  const closedAny = estimates.filter((e) =>
    ['Converted', 'Accepted', 'Rejected'].includes(e.TxnStatus ?? '')
  ).length;
  const closeRatePct = (closedSold / closedAny) * 100;

  // Monthly P&L
  const cols = monthlyPnl.Columns?.Column ?? [];
  const monthLabels = cols.slice(1, -1).map((c) => c.ColTitle); // drop label col + total col
  const monthlyRows = monthlyPnl.Rows?.Row ?? [];
  const incomeRow = findRow(monthlyRows, 'Total Income');
  const cogsRow = findRow(monthlyRows, 'Total Cost of Goods Sold');
  const opexRow = findRow(monthlyRows, 'Total Expenses');
  const niRow = findRow(monthlyRows, 'Net Income');

  const monthly = monthLabels.map((m, i) => ({
    month: m,
    revenue: num(incomeRow?.[i + 1]?.value),
    cogs: num(cogsRow?.[i + 1]?.value),
    opex: num(opexRow?.[i + 1]?.value),
    netIncome: num(niRow?.[i + 1]?.value),
  }));

  // Revenue + net income totals per calendar year (Jan–Dec)
  const yearTotals = new Map<string, { revenue: number; netIncome: number; months: number }>();
  for (const m of monthly) {
    const ym = m.month.match(/(\d{4})/);
    if (!ym) continue;
    const year = ym[1];
    const cur = yearTotals.get(year) ?? { revenue: 0, netIncome: 0, months: 0 };
    cur.revenue += m.revenue;
    cur.netIncome += m.netIncome;
    cur.months += 1;
    yearTotals.set(year, cur);
  }
  const calendarYears = [...yearTotals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, t]) => ({
      year,
      revenue: t.revenue,
      netIncome: t.netIncome,
      months: t.months,
      complete: t.months === 12,
    }));

  // YoY same-month comparison (any month present in both years)
  const yoyMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // QBO labels a partial month "Jul 1-28, 2026" — include its revenue, but
  // suppress the growth multiplier (partial vs. full month is not comparable).
  const monthMap2025 = new Map<string, number>();
  const monthMap2026 = new Map<string, number>();
  const partialMonths = new Set<string>();
  for (const m of monthly) {
    const mm = m.month.match(/^(\w+)\b.*?(\d{4})$/);
    if (!mm) continue;
    const monthShort = mm[1].slice(0, 3);
    const year = mm[2];
    if (year === '2025') monthMap2025.set(monthShort, m.revenue);
    if (year === '2026') monthMap2026.set(monthShort, m.revenue);
    if (/\d+-\d+,/.test(m.month)) partialMonths.add(`${monthShort} ${year}`);
  }
  const yoy = yoyMonths
    .filter((m) => monthMap2025.has(m) || monthMap2026.has(m))
    .map((m) => {
      const y2025 = monthMap2025.get(m) ?? 0;
      const y2026 = monthMap2026.get(m) ?? 0;
      const partial = partialMonths.has(`${m} 2025`) || partialMonths.has(`${m} 2026`);
      const growth = !partial && y2025 > 0 && y2026 > 0 ? y2026 / y2025 : null;
      return { month: m, y2025, y2026, growth };
    });

  // Cumulative revenue
  let running = 0;
  const cumulative = monthly.map((m) => {
    running += m.revenue;
    return { month: m.month, total: running };
  });

  // Top customers
  const byCust = new Map<string, { name: string; total: number; count: number }>();
  for (const inv of invoices) {
    const cid = inv.CustomerRef?.value ?? 'unknown';
    const name = inv.CustomerRef?.name ?? 'Unknown';
    const cur = byCust.get(cid) ?? { name, total: 0, count: 0 };
    cur.total += inv.TotalAmt;
    cur.count += 1;
    byCust.set(cid, cur);
  }
  const topCustomers = [...byCust.values()].sort((a, b) => b.total - a.total).slice(0, 15);

  // Quote funnel
  const statusCounts = new Map<string, number>();
  for (const e of estimates) {
    const s = e.TxnStatus ?? 'Unknown';
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  const quoteFunnel = [...statusCounts.entries()].map(([status, count]) => ({ status, count }));

  // OpEx categories — pull from total P&L. The Expenses section has group="Expenses".
  const opexParent = (totalRows as QBNamedRow[]).find((r) => r.group === 'Expenses');
  const opexCategories: Array<{ category: string; amount: number }> = [];
  // walk the Expenses block — entries with ColData are leaf accounts
  function walkOpex(rows: QBRow[]): void {
    for (const r of rows) {
      if (r.ColData && r.ColData.length >= 2) {
        const label = r.ColData[0].value;
        const amount = num(r.ColData[1].value);
        if (amount !== 0 && !label.toLowerCase().startsWith('total')) {
          opexCategories.push({ category: label, amount });
        }
      }
      if (r.Rows) {
        // For nested categories (Payroll, Office, etc), pull the summary line
        if (r.Summary?.ColData[0]?.value.toLowerCase().startsWith('total ')) {
          const label = r.Summary.ColData[0].value.replace(/^total /i, '');
          const amount = num(r.Summary.ColData[1].value);
          if (amount !== 0) opexCategories.push({ category: label, amount });
        } else {
          walkOpex(r.Rows.Row);
        }
      }
    }
  }
  if (opexParent?.Rows) walkOpex(opexParent.Rows.Row);
  opexCategories.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // ── YTD-through-today comparison (current year vs prior year, same date span) ──
  let ytdCompare: DashboardData['ytdCompare'] = null;
  const ytdCurrentFile = path.join(dataDir, 'pnl-ytd-accrual.json');
  const ytdPriorFile = path.join(dataDir, 'pnl-prior-ytd-accrual.json');
  if (fs.existsSync(ytdCurrentFile) && fs.existsSync(ytdPriorFile)) {
    const ytdCurrent = loadJson<QBReport>(ytdCurrentFile);
    const ytdPrior = loadJson<QBReport>(ytdPriorFile);
    const curRev = num(findRow(ytdCurrent.Rows?.Row, 'Total Income')?.[1]?.value);
    const priRev = num(findRow(ytdPrior.Rows?.Row, 'Total Income')?.[1]?.value);
    const curNi = num(findRow(ytdCurrent.Rows?.Row, 'Net Income')?.[1]?.value);
    const priNi = num(findRow(ytdPrior.Rows?.Row, 'Net Income')?.[1]?.value);
    ytdCompare = {
      currentYear: parseInt(ytdCurrent.Header?.StartPeriod?.slice(0, 4) ?? '0', 10),
      priorYear: parseInt(ytdPrior.Header?.StartPeriod?.slice(0, 4) ?? '0', 10),
      currentRevenue: curRev,
      priorRevenue: priRev,
      currentNetIncome: curNi,
      priorNetIncome: priNi,
      currentPeriod: {
        start: ytdCurrent.Header?.StartPeriod ?? '',
        end: ytdCurrent.Header?.EndPeriod ?? '',
      },
      priorPeriod: {
        start: ytdPrior.Header?.StartPeriod ?? '',
        end: ytdPrior.Header?.EndPeriod ?? '',
      },
      revenueMultiplier: priRev > 0 ? curRev / priRev : null,
    };
  }

  // ── Bank-reconciled data (optional — present only if ingest-bank.ts has run) ──
  let marketing: DashboardData['marketing'] = null;
  let payrollPaychecks: DashboardData['payrollPaychecks'] = null;
  let opexDetail: DashboardData['opexDetail'] = null;

  const bankReconciledDir = path.resolve(path.dirname(dataDir), 'bank-reconciled');
  const txnFile = path.join(bankReconciledDir, 'transactions.json');
  if (fs.existsSync(txnFile)) {
    const bankTxns = loadJson<BankTxn[]>(txnFile);

    // Marketing breakdown
    const mktTxns = bankTxns.filter((t) =>
      (t.category.startsWith('Marketing') || t.category.startsWith('Advertising')) && t.amount < 0
    );
    const mktMonths = [...new Set(mktTxns.map((t) => t.monthKey))].sort();
    const mktCatTotals = new Map<string, number>();
    for (const t of mktTxns) mktCatTotals.set(t.category, (mktCatTotals.get(t.category) ?? 0) + (-t.amount));
    const mktCats = [...mktCatTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const mktSeries = mktCats.map((cat) => {
      const values = mktMonths.map((m) =>
        mktTxns
          .filter((t) => t.monthKey === m && t.category === cat)
          .reduce((s, t) => s + (-t.amount), 0)
      );
      return { category: cat, values, total: mktCatTotals.get(cat) ?? 0 };
    });
    marketing = {
      months: mktMonths,
      series: mktSeries,
      totalSpend: [...mktCatTotals.values()].reduce((a, b) => a + b, 0),
    };

    // Per-paycheck payroll trajectory (only since salesperson started: Nov 2025+)
    const TECH_PER_CHECK = 1584.66;
    const wageTxns = bankTxns
      .filter((t) => t.category === 'Payroll (Wages Impound)' && t.postedDate >= '2025-11')
      .sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    payrollPaychecks = wageTxns.map((t) => {
      const total = -t.amount;
      // First paycheck where total > tech baseline = salesperson onboarded
      const sp = Math.max(0, total - TECH_PER_CHECK);
      return {
        date: t.postedDate.slice(0, 10),
        total,
        tech: Math.min(total, TECH_PER_CHECK),
        salesperson: sp,
      };
    });

    // ── OpEx detail: recurring (subscriptions) + variable (gas, hardware) ──
    const allMonths = [...new Set(bankTxns.map((t) => t.monthKey))].sort();
    const periodEndMonth = allMonths[allMonths.length - 1] ?? '';
    const periodStartMonth = allMonths[0] ?? '';
    const monthsCovered = allMonths.length;

    // Average monthly OpEx — outflows excluding revenue, internal transfers,
    // and payroll wages (which already get their own treatment)
    const excludeFromOpEx = new Set([
      'Internal Transfer',
      'Payroll (Wages Impound)',
      'Payroll (Taxes)',
      'Cash / Check (manual review)',
    ]);
    const opexOutflows = bankTxns.filter(
      (t) => t.amount < 0 && !t.category.startsWith('Revenue') && !excludeFromOpEx.has(t.category),
    );
    const totalOpExOutflow = opexOutflows.reduce((s, t) => s + Math.abs(t.amount), 0);
    const avgMonthlyOpEx = totalOpExOutflow / Math.max(1, monthsCovered);

    const recurring = detectRecurring(bankTxns, periodEndMonth);
    const variable = detectVariable(bankTxns);
    const recommendations = buildRecommendations(recurring, variable);

    const activeRecurring = recurring.filter((r) => r.stillActive);
    const recurringTotal = activeRecurring.reduce((s, r) => s + r.monthlyEquivalent, 0);
    const recurringAnnualized = activeRecurring.reduce((s, r) => s + r.annualizedSpend, 0);

    opexDetail = {
      periodStart: periodStartMonth,
      periodEnd: periodEndMonth,
      monthsCovered,
      avgMonthlyOpEx,
      recurring,
      recurringTotal,
      recurringAnnualized,
      variable,
      recommendations,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    periodStart: monthlyPnl.Header?.StartPeriod ?? '',
    periodEnd: monthlyPnl.Header?.EndPeriod ?? '',
    headline: {
      revenue: totalRev,
      grossProfit: totalGrossProfit,
      netIncome: totalNetIncome,
      trueGrossMarginPct: trueGrossMargin,
      cash,
      debt,
      customers: customers.length,
      invoices: invoices.length,
      avgTicket,
      closeRatePct,
    },
    monthly,
    calendarYears,
    yoy,
    cumulative,
    topCustomers,
    quoteFunnel,
    opexCategories,
    marketing,
    payrollPaychecks,
    opexDetail,
    ytdCompare,
  };
}

// ── HTML template ────────────────────────────────────────────────────

function renderHtml(data: DashboardData): string {
  const json = JSON.stringify(data);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AAC — Business Diagnostic Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0b0d10; color: #e6e9ef; }
  header { padding: 24px 32px; border-bottom: 1px solid #1e2530; background: #11151b; }
  header h1 { margin: 0; font-size: 22px; font-weight: 600; }
  header .meta { color: #8a94a6; margin-top: 6px; font-size: 13px; }
  main { padding: 24px 32px; max-width: 1600px; margin: 0 auto; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: #161b22; border: 1px solid #1e2530; border-radius: 8px; padding: 16px; }
  .tile .label { color: #8a94a6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .tile .value { font-size: 22px; font-weight: 600; margin-top: 6px; color: #f0f3f8; }
  .tile .sub { color: #8a94a6; font-size: 12px; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid.three { grid-template-columns: 1fr 1fr 1fr; }
  .grid > div { background: #161b22; border: 1px solid #1e2530; border-radius: 8px; padding: 16px; }
  .grid h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #c8d0dc; }
  .chart-wrap { position: relative; height: 280px; }
  .chart-wrap.tall { height: 380px; }
  .full { grid-column: 1 / -1; }
  .ytd-card { background: #161b22; border: 1px solid #1e2530; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
  .ytd-card .ytd-title { color: #c8d0dc; font-size: 14px; font-weight: 600; margin: 0 0 4px; }
  .ytd-card .ytd-sub { color: #8a94a6; font-size: 12px; margin-bottom: 16px; }
  .ytd-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  .cy-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
  .cy-col { padding: 12px 0; }
  .cy-col .ytd-label { color: #8a94a6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .cy-col .ytd-value { font-size: 28px; font-weight: 700; margin-top: 6px; color: #f0f3f8; }
  .cy-col .ytd-ni { color: #8a94a6; font-size: 12px; margin-top: 4px; }
  .cy-col .cy-partial { color: #d29922; }
  .ytd-col { padding: 12px 0; }
  .ytd-col .ytd-label { color: #8a94a6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .ytd-col .ytd-value { font-size: 28px; font-weight: 700; margin-top: 6px; color: #f0f3f8; }
  .ytd-col .ytd-ni { color: #8a94a6; font-size: 12px; margin-top: 4px; }
  .ytd-col.mult .ytd-value { color: #2ea043; font-size: 36px; }
  .ytd-col.mult.down .ytd-value { color: #cf222e; }
  @media (max-width: 700px) { .ytd-row { grid-template-columns: 1fr; } }
  footer { color: #6b7585; font-size: 12px; padding: 24px 32px; text-align: center; }
  a { color: #6ea8fe; }
  @media (max-width: 900px) { .grid, .grid.three { grid-template-columns: 1fr; } }

  /* ── OpEx detail section ───────────────────────────────────────── */
  .opex-section { margin-top: 32px; }
  .opex-section h1.section-title { font-size: 18px; margin: 0 0 4px; color: #f0f3f8; padding-top: 8px; border-top: 1px solid #1e2530; padding-top: 24px; }
  .opex-section p.section-sub { color: #8a94a6; font-size: 13px; margin: 0 0 16px; }
  .opex-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .opex-card { background: #161b22; border: 1px solid #1e2530; border-radius: 8px; padding: 16px 18px; }
  .opex-card h3 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #c8d0dc; }
  .opex-card .opex-card-sub { color: #8a94a6; font-size: 12px; margin-top: -8px; margin-bottom: 12px; }
  .sub-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .sub-table th { text-align: left; color: #8a94a6; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #1e2530; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .sub-table td { padding: 8px; border-bottom: 1px solid #161b22; }
  .sub-table tr:hover td { background: #1a1f27; }
  .sub-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .sub-table td.merchant { color: #e6e9ef; font-weight: 500; }
  .sub-table td.muted { color: #6b7585; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.active { background: #1b3a23; color: #56d364; }
  .badge.inactive { background: #3a1f1f; color: #f78166; }
  .badge.cadence-monthly { background: #1f2937; color: #6ea8fe; }
  .badge.cadence-quarterly { background: #2a213a; color: #a371f7; }
  .badge.cadence-annual { background: #3a2f1a; color: #d29922; }
  .badge.cadence-irregular { background: #1e2530; color: #8a94a6; }
  .var-bucket { background: #161b22; border: 1px solid #1e2530; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .var-bucket-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .var-bucket-name { font-size: 14px; font-weight: 600; color: #f0f3f8; }
  .var-bucket-stats { color: #8a94a6; font-size: 12px; }
  .var-spark-wrap { position: relative; height: 44px; margin: 8px 0; }
  .var-merchants { color: #8a94a6; font-size: 12px; line-height: 1.5; }
  .var-merchants strong { color: #c8d0dc; font-weight: 500; }
  .rec-list { display: grid; gap: 12px; }
  .rec { background: #161b22; border: 1px solid #1e2530; border-left: 3px solid #6b7585; border-radius: 8px; padding: 14px 16px; }
  .rec.high { border-left-color: #cf222e; }
  .rec.medium { border-left-color: #d29922; }
  .rec.low { border-left-color: #6ea8fe; }
  .rec-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .rec-title { font-size: 14px; font-weight: 600; color: #f0f3f8; }
  .rec-savings { color: #56d364; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .rec-kind { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 6px; }
  .rec-kind.bulk { background: #1b3a23; color: #56d364; }
  .rec-kind.consolidate { background: #1f2937; color: #6ea8fe; }
  .rec-kind.audit { background: #3a2f1a; color: #d29922; }
  .rec-kind.stop { background: #3a1f1f; color: #f78166; }
  .rec-kind.switch { background: #2a213a; color: #a371f7; }
  .rec-detail { color: #c8d0dc; font-size: 13px; line-height: 1.5; margin: 4px 0 0; }
  .rec-evidence { color: #6b7585; font-size: 11px; line-height: 1.6; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #1e2530; font-family: ui-monospace, SFMono-Regular, monospace; }
  .opex-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .opex-grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>AAC — Business Diagnostic</h1>
  <div class="meta">
    Period <span id="period"></span> · Generated <span id="generated"></span> ·
    Data: <code>analysis/data/qbo/</code>
  </div>
</header>
<main>
  <section class="tiles" id="tiles"></section>

  <section class="ytd-card" id="cy-card" style="display:none;">
    <div class="ytd-title">Revenue by calendar year (Jan–Dec)</div>
    <div class="ytd-sub">QuickBooks Total Income, accrual basis. Partial years flagged.</div>
    <div class="cy-row" id="cy-row"></div>
  </section>

  <section class="ytd-card" id="ytd-card" style="display:none;">
    <div class="ytd-title">Year-to-date revenue — apples-to-apples</div>
    <div class="ytd-sub" id="ytd-sub"></div>
    <div class="ytd-row" id="ytd-row"></div>
  </section>

  <section class="grid">
    <div class="full">
      <h2>Monthly revenue — Sept 2024 → present</h2>
      <div class="chart-wrap tall"><canvas id="revenue"></canvas></div>
    </div>

    <div>
      <h2>YoY same-month comparison (2025 vs 2026)</h2>
      <div class="chart-wrap"><canvas id="yoy"></canvas></div>
    </div>

    <div>
      <h2>Cumulative revenue</h2>
      <div class="chart-wrap"><canvas id="cumulative"></canvas></div>
    </div>

    <div class="full">
      <h2>Net income by month (red = loss)</h2>
      <div class="chart-wrap"><canvas id="netincome"></canvas></div>
    </div>

    <div>
      <h2>Top 15 customers by revenue</h2>
      <div class="chart-wrap tall"><canvas id="customers"></canvas></div>
    </div>

    <div>
      <h2>OpEx by category (full period)</h2>
      <div class="chart-wrap tall"><canvas id="opex"></canvas></div>
    </div>

    <div class="full">
      <h2>Quote funnel — estimates by status</h2>
      <div class="chart-wrap"><canvas id="funnel"></canvas></div>
    </div>

    <div class="full" id="marketing-card" style="display:none;">
      <h2>Marketing spend by sub-category (monthly, from bank data)</h2>
      <div class="chart-wrap tall"><canvas id="marketing"></canvas></div>
    </div>

    <div class="full" id="payroll-card" style="display:none;">
      <h2>Payroll per paycheck — tech (steady) vs. salesperson (declining)</h2>
      <div class="chart-wrap"><canvas id="payroll"></canvas></div>
    </div>
  </section>

  <section class="opex-section" id="opex-detail" style="display:none;">
    <h1 class="section-title">Operating expense detail — granular</h1>
    <p class="section-sub" id="opex-detail-sub"></p>

    <div class="opex-tiles" id="opex-detail-tiles"></div>

    <div class="opex-card" style="margin-bottom: 16px;">
      <h3>Recurring spend — subscriptions, fees, and monthly bills</h3>
      <div class="opex-card-sub" id="opex-recurring-sub"></div>
      <div style="overflow-x: auto;">
        <table class="sub-table" id="opex-recurring-table"></table>
      </div>
    </div>

    <div class="opex-card" style="margin-bottom: 16px;">
      <h3>Variable operational spend — gas, materials, ad-hoc</h3>
      <div class="opex-card-sub">Buckets where you spend money frequently but in varying amounts. Trip count + per-trip avg show where consolidation could save time and money.</div>
      <div id="opex-variable-list"></div>
    </div>

    <div class="opex-card">
      <h3>Recommendations — where to cut, consolidate, or audit</h3>
      <div class="opex-card-sub">Generated from the recurring + variable patterns above. Each one names a specific merchant or bucket so you can act without rerunning the analysis.</div>
      <div class="rec-list" id="opex-rec-list"></div>
    </div>
  </section>
</main>
<footer>
  Regenerate with: <code>npx tsx tools/src/analysis/pull-qbo-baseline.ts && npx tsx tools/src/analysis/ingest-bank.ts && npx tsx tools/src/analysis/build-dashboard.ts</code>
</footer>

<script>
const D = ${json};

const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
const fmt$k = (n) => n >= 1000 ? '$' + (n/1000).toFixed(1) + 'k' : '$' + Math.round(n).toLocaleString();
const fmtPct = (n) => n.toFixed(1) + '%';

document.getElementById('period').textContent = D.periodStart + ' → ' + D.periodEnd;
document.getElementById('generated').textContent = new Date(D.generatedAt).toLocaleString();

// Tiles
const tiles = [
  ['Total revenue', fmt$(D.headline.revenue), 'Sept 2024 → present'],
  ['Net income', fmt$(D.headline.netIncome), 'Accrual basis'],
  ['True gross margin', fmtPct(D.headline.trueGrossMarginPct), 'After labor allocation'],
  ['Cash on hand', fmt$(D.headline.cash), \`Debt: \${fmt$(D.headline.debt)}\`],
  ['Active customers', D.headline.customers.toLocaleString(), \`\${D.headline.invoices} invoices issued\`],
  ['Avg ticket', fmt$(D.headline.avgTicket), 'Per invoice'],
  ['Close rate', fmtPct(D.headline.closeRatePct), 'Converted ÷ decided quotes'],
];
document.getElementById('tiles').innerHTML = tiles.map(([l, v, s]) =>
  \`<div class="tile"><div class="label">\${l}</div><div class="value">\${v}</div><div class="sub">\${s}</div></div>\`
).join('');

// Revenue by calendar year
if (D.calendarYears && D.calendarYears.length) {
  document.getElementById('cy-card').style.display = '';
  document.getElementById('cy-row').innerHTML = D.calendarYears.map(y => {
    const tag = y.complete ? '' : \`<div class="ytd-ni cy-partial">Partial — \${y.months} mo</div>\`;
    const ni = \`<div class="ytd-ni">Net income: \${fmt$(y.netIncome)}</div>\`;
    return \`<div class="cy-col"><div class="ytd-label">\${y.year} revenue</div><div class="ytd-value">\${fmt$(y.revenue)}</div>\${ni}\${tag}</div>\`;
  }).join('');
}

// YTD apples-to-apples comparison card
if (D.ytdCompare) {
  const y = D.ytdCompare;
  document.getElementById('ytd-card').style.display = '';
  document.getElementById('ytd-sub').textContent =
    \`\${y.priorPeriod.start} → \${y.priorPeriod.end}  vs.  \${y.currentPeriod.start} → \${y.currentPeriod.end}\`;
  const mult = y.revenueMultiplier;
  const multClass = mult !== null && mult < 1 ? 'mult down' : 'mult';
  const multText = mult !== null ? mult.toFixed(2) + 'x' : '—';
  document.getElementById('ytd-row').innerHTML = [
    \`<div class="ytd-col"><div class="ytd-label">YTD \${y.priorYear} revenue</div><div class="ytd-value">\${fmt$(y.priorRevenue)}</div></div>\`,
    \`<div class="ytd-col"><div class="ytd-label">YTD \${y.currentYear} revenue</div><div class="ytd-value">\${fmt$(y.currentRevenue)}</div></div>\`,
    \`<div class="ytd-col \${multClass}"><div class="ytd-label">YoY multiplier</div><div class="ytd-value">\${multText}</div><div class="ytd-ni">+\${fmt$(y.currentRevenue - y.priorRevenue)} vs. prior year</div></div>\`,
  ].join('');
}

Chart.defaults.color = '#8a94a6';
Chart.defaults.borderColor = '#1e2530';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';

const dollarTicks = { ticks: { callback: (v) => fmt$k(v) } };

// Monthly revenue
new Chart(document.getElementById('revenue'), {
  type: 'bar',
  data: {
    labels: D.monthly.map(m => m.month),
    datasets: [{ label: 'Revenue', data: D.monthly.map(m => m.revenue), backgroundColor: '#2ea043', borderRadius: 4 }]
  },
  options: {
    maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { y: dollarTicks }
  }
});

// YoY
new Chart(document.getElementById('yoy'), {
  type: 'bar',
  data: {
    labels: D.yoy.map(y => y.month),
    datasets: [
      { label: '2025', data: D.yoy.map(y => y.y2025), backgroundColor: '#6b7585', borderRadius: 4 },
      { label: '2026', data: D.yoy.map(y => y.y2026), backgroundColor: '#2ea043', borderRadius: 4 },
    ]
  },
  options: {
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' },
      tooltip: { callbacks: {
        afterBody: (items) => {
          const idx = items[0].dataIndex;
          const g = D.yoy[idx].growth;
          return g ? \`Growth: \${g.toFixed(2)}x\` : '';
        }
      }}
    },
    scales: { y: dollarTicks }
  }
});

// Cumulative
new Chart(document.getElementById('cumulative'), {
  type: 'line',
  data: {
    labels: D.cumulative.map(c => c.month),
    datasets: [{ label: 'Cumulative revenue', data: D.cumulative.map(c => c.total),
                 borderColor: '#6ea8fe', backgroundColor: 'rgba(110,168,254,0.15)', fill: true, tension: 0.3, pointRadius: 0 }]
  },
  options: {
    maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { y: dollarTicks }
  }
});

// Net income — color by sign
new Chart(document.getElementById('netincome'), {
  type: 'bar',
  data: {
    labels: D.monthly.map(m => m.month),
    datasets: [{
      label: 'Net income',
      data: D.monthly.map(m => m.netIncome),
      backgroundColor: D.monthly.map(m => m.netIncome >= 0 ? '#2ea043' : '#cf222e'),
      borderRadius: 4
    }]
  },
  options: {
    maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { y: dollarTicks }
  }
});

// Top customers
new Chart(document.getElementById('customers'), {
  type: 'bar',
  data: {
    labels: D.topCustomers.map(c => c.name.length > 28 ? c.name.slice(0, 26) + '…' : c.name),
    datasets: [{ label: 'Revenue', data: D.topCustomers.map(c => c.total),
                 backgroundColor: '#6ea8fe', borderRadius: 4 }]
  },
  options: {
    maintainAspectRatio: false, indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: {
        afterLabel: (item) => {
          const c = D.topCustomers[item.dataIndex];
          return \`\${c.count} invoice\${c.count > 1 ? 's' : ''}\`;
        }
      }}
    },
    scales: { x: dollarTicks }
  }
});

// OpEx categories (top 12)
const topOpex = D.opexCategories.slice(0, 12);
new Chart(document.getElementById('opex'), {
  type: 'bar',
  data: {
    labels: topOpex.map(o => o.category),
    datasets: [{ label: 'OpEx', data: topOpex.map(o => o.amount),
                 backgroundColor: '#d29922', borderRadius: 4 }]
  },
  options: {
    maintainAspectRatio: false, indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: dollarTicks }
  }
});

// Quote funnel
const funnelColors = { Converted: '#2ea043', Accepted: '#56d364', Pending: '#d29922', Rejected: '#cf222e', Closed: '#6b7585', Unknown: '#444c56' };
new Chart(document.getElementById('funnel'), {
  type: 'bar',
  data: {
    labels: D.quoteFunnel.map(q => q.status),
    datasets: [{
      label: 'Quotes',
      data: D.quoteFunnel.map(q => q.count),
      backgroundColor: D.quoteFunnel.map(q => funnelColors[q.status] || '#6b7585'),
      borderRadius: 4
    }]
  },
  options: {
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: {
        afterLabel: (item) => {
          const total = D.quoteFunnel.reduce((s, q) => s + q.count, 0);
          return fmtPct(100 * item.parsed.y / total) + ' of all quotes';
        }
      }}
    }
  }
});

// Marketing breakdown (only if bank data is present)
if (D.marketing) {
  document.getElementById('marketing-card').style.display = '';
  const palette = ['#6ea8fe', '#2ea043', '#d29922', '#cf222e', '#a371f7', '#56d364', '#8b949e', '#f78166', '#39c5cf', '#e3b341'];
  const datasets = D.marketing.series.map((s, i) => ({
    label: s.category.replace('Advertising (', '').replace('Marketing (', '').replace(')', '') + ' ($' + (s.total).toFixed(0) + ' total)',
    data: s.values,
    backgroundColor: palette[i % palette.length],
    borderRadius: 2,
    stack: 'mkt',
  }));
  new Chart(document.getElementById('marketing'), {
    type: 'bar',
    data: { labels: D.marketing.months, datasets },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => fmt$k(v) } } }
    }
  });
}

// Payroll per-paycheck
if (D.payrollPaychecks && D.payrollPaychecks.length) {
  document.getElementById('payroll-card').style.display = '';
  new Chart(document.getElementById('payroll'), {
    type: 'bar',
    data: {
      labels: D.payrollPaychecks.map(p => p.date),
      datasets: [
        { label: 'Existing tech', data: D.payrollPaychecks.map(p => p.tech), backgroundColor: '#6b7585', borderRadius: 2, stack: 'p' },
        { label: 'Salesperson', data: D.payrollPaychecks.map(p => p.salesperson), backgroundColor: '#cf222e', borderRadius: 2, stack: 'p' },
      ]
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: {
          afterBody: (items) => {
            const p = D.payrollPaychecks[items[0].dataIndex];
            return 'Total: ' + fmt$(p.total);
          }
        }}
      },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => fmt$k(v) } } }
    }
  });
}

// ── OpEx granular detail (subscriptions, variable spend, recommendations) ─────
if (D.opexDetail) {
  const od = D.opexDetail;
  document.getElementById('opex-detail').style.display = '';
  document.getElementById('opex-detail-sub').textContent =
    \`Built from bank transactions \${od.periodStart} → \${od.periodEnd} (\${od.monthsCovered} months). Excludes payroll wages and internal transfers.\`;

  // Summary tiles
  const activeRec = od.recurring.filter(r => r.stillActive);
  const opexTiles = [
    ['Avg monthly OpEx', fmt$(od.avgMonthlyOpEx), 'Non-wage outflow'],
    ['Recurring monthly', fmt$(od.recurringTotal), \`\${activeRec.length} active subscriptions\`],
    ['Recurring annualized', fmt$(od.recurringAnnualized), 'If nothing changes'],
    ['Recommendations', String(od.recommendations.length), 'Below'],
  ];
  document.getElementById('opex-detail-tiles').innerHTML = opexTiles.map(([l, v, s]) =>
    \`<div class="opex-card" style="padding: 14px 16px;"><div style="color:#8a94a6;font-size:11px;text-transform:uppercase;letter-spacing:0.05em">\${l}</div><div style="font-size:22px;font-weight:600;margin-top:6px;color:#f0f3f8">\${v}</div><div style="color:#8a94a6;font-size:12px;margin-top:2px">\${s}</div></div>\`
  ).join('');

  // Recurring table
  document.getElementById('opex-recurring-sub').textContent =
    \`\${od.recurring.length} merchants charging on a regular cadence. Click a header to sort if needed (static table — sort manually for now).\`;
  const recHeader = '<thead><tr><th>Merchant</th><th>Category</th><th>Cadence</th><th class="num">Per charge</th><th class="num">Monthly equiv</th><th class="num">Annualized</th><th>Status</th><th class="num">Last seen</th></tr></thead>';
  const recRows = od.recurring.slice(0, 60).map(r => {
    const statusBadge = r.stillActive
      ? '<span class="badge active">active</span>'
      : '<span class="badge inactive">inactive</span>';
    const cadenceBadge = \`<span class="badge cadence-\${r.cadence}">\${r.cadence}</span>\`;
    return \`<tr>
      <td class="merchant">\${r.merchant}</td>
      <td class="muted">\${r.category}</td>
      <td>\${cadenceBadge}</td>
      <td class="num">\$\${r.avgAmount.toFixed(2)}</td>
      <td class="num">\$\${r.monthlyEquivalent.toFixed(2)}</td>
      <td class="num"><strong>\$\${Math.round(r.annualizedSpend).toLocaleString()}</strong></td>
      <td>\${statusBadge}</td>
      <td class="num muted">\${r.lastSeen}</td>
    </tr>\`;
  }).join('');
  document.getElementById('opex-recurring-table').innerHTML = recHeader + '<tbody>' + recRows + '</tbody>';

  // Variable spend buckets
  const palette2 = ['#6ea8fe', '#2ea043', '#d29922', '#cf222e', '#a371f7', '#56d364', '#f78166', '#39c5cf'];
  document.getElementById('opex-variable-list').innerHTML = od.variable.map((v, i) => {
    const tripsPerMo = (v.tripCount / v.months.length).toFixed(1);
    const merchantsHtml = v.topMerchants.map(m =>
      \`<strong>\${m.merchant}</strong> (\${m.count}x, \$\${Math.round(m.total).toLocaleString()})\`
    ).join(' · ');
    return \`<div class="var-bucket">
      <div class="var-bucket-head">
        <div class="var-bucket-name">\${v.bucket}</div>
        <div class="var-bucket-stats">\$\${Math.round(v.monthlyAvg).toLocaleString()}/mo avg · \${v.tripCount} trips (\${tripsPerMo}/mo) · \$\${Math.round(v.avgPerTrip)}/trip · last \${v.lastTrip}</div>
      </div>
      <div class="var-spark-wrap"><canvas id="var-spark-\${i}"></canvas></div>
      <div class="var-merchants">\${merchantsHtml}</div>
    </div>\`;
  }).join('');

  // Render sparklines for each variable bucket
  od.variable.forEach((v, i) => {
    const canvas = document.getElementById('var-spark-' + i);
    if (!canvas) return;
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: v.months,
        datasets: [{ label: v.bucket, data: v.monthlyTrend, backgroundColor: palette2[i % palette2.length], borderRadius: 2 }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (item) => fmt$(item.parsed.y) } }
        },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  });

  // Recommendations
  document.getElementById('opex-rec-list').innerHTML = od.recommendations.map(r => {
    const savings = r.estimatedAnnualSavings ? \`<div class="rec-savings">~\${fmt$(r.estimatedAnnualSavings)}/yr</div>\` : '';
    const evidence = (r.evidence && r.evidence.length)
      ? '<div class="rec-evidence">' + r.evidence.map(e => '• ' + e).join('<br>') + '</div>'
      : '';
    return \`<div class="rec \${r.priority}">
      <div class="rec-head">
        <div class="rec-title"><span class="rec-kind \${r.kind}">\${r.kind}</span>\${r.title}</div>
        \${savings}
      </div>
      <p class="rec-detail">\${r.detail}</p>
      \${evidence}
    </div>\`;
  }).join('');
}
</script>
</body>
</html>
`;
}

// ── main ─────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = process.cwd();
  const dataDir = path.resolve(projectRoot, 'analysis/data/qbo');
  const outFile = path.resolve(projectRoot, 'analysis/dashboard.html');

  if (!fs.existsSync(dataDir)) {
    console.error(`Data dir not found: ${dataDir}`);
    console.error('Run pull-qbo-baseline.ts first.');
    process.exit(1);
  }

  console.log(`Building dashboard from ${dataDir}`);
  const data = build(dataDir);
  const html = renderHtml(data);
  fs.writeFileSync(outFile, html);
  console.log(`Wrote ${outFile} (${html.length.toLocaleString()} bytes)`);
  console.log(`Open with: open '${outFile}'`);
}

main();
