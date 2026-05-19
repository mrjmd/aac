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

  // YoY same-month comparison (any month present in both years)
  const yoyMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthMap2025 = new Map<string, number>();
  const monthMap2026 = new Map<string, number>();
  for (const m of monthly) {
    const mm = m.month.match(/^(\w+) (\d{4})/);
    if (!mm) continue;
    const monthShort = mm[1].slice(0, 3);
    const year = mm[2];
    if (year === '2025') monthMap2025.set(monthShort, m.revenue);
    if (year === '2026') monthMap2026.set(monthShort, m.revenue);
  }
  const yoy = yoyMonths
    .filter((m) => monthMap2025.has(m) || monthMap2026.has(m))
    .map((m) => {
      const y2025 = monthMap2025.get(m) ?? 0;
      const y2026 = monthMap2026.get(m) ?? 0;
      const growth = y2025 > 0 && y2026 > 0 ? y2026 / y2025 : null;
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

  const bankReconciledDir = path.resolve(path.dirname(dataDir), 'bank-reconciled');
  const txnFile = path.join(bankReconciledDir, 'transactions.json');
  if (fs.existsSync(txnFile)) {
    interface BankTxn { postedDate: string; monthKey: string; category: string; amount: number; rawDescription: string; }
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
    yoy,
    cumulative,
    topCustomers,
    quoteFunnel,
    opexCategories,
    marketing,
    payrollPaychecks,
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
</main>
<footer>
  Regenerate with: <code>npx tsx tools/src/analysis/pull-qbo-baseline.ts && npx tsx tools/src/analysis/build-dashboard.ts</code>
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
