#!/usr/bin/env npx tsx
/**
 * Ed commission report — render.
 *
 * Reads findings.json, writes:
 *   - analysis/commissions.html (self-contained, file:// friendly)
 *   - analysis/data/commissions/email.md (payroll-ready email body)
 */
import fs from 'node:fs';
import {
  readJson, FINDINGS_PATH, REPORT_PATH, EMAIL_PATH,
  type Findings,
} from './lib';

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const musd = (n: number): string => usd(n).replace('$', '\\$');

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function main(): void {
  const findings = readJson<Findings | null>(FINDINGS_PATH, null);
  if (!findings) throw new Error(`No findings at ${FINDINGS_PATH} — run analyze.ts first`);

  const owed = findings.events.filter((e) => !e.paidToEd);
  const paid = findings.events.filter((e) => e.paidToEd);
  const owedTotal = owed.reduce((s, e) => s + e.commission, 0);
  const paidTotal = paid.reduce((s, e) => s + e.commission, 0);
  const pendingTotal = findings.pendingInvoices.reduce((s, e) => s + e.commission, 0);
  const potentialTotal = findings.openEstimates.reduce((s, e) => s + e.commission, 0);
  const ratePct = `${(findings.rate * 100).toFixed(0)}%`;
  const runDate = findings.runAt.slice(0, 10);

  // ── email body (payroll-ready, dollar signs escaped for md renderers) ──
  const md: string[] = [];
  md.push(`# Ed commission report — run ${runDate}`);
  md.push('');
  if (owed.length === 0) {
    md.push('No unpaid commissions — Ed is fully paid up.');
  } else {
    md.push('## For payroll');
    md.push('');
    md.push(`Please add a commission payment of **${musd(owedTotal)}** to Ed Crowell's next payroll run.`);
    md.push('');
    md.push('| Invoice | Customer | Commission |');
    md.push('|---|---|---:|');
    for (const e of owed) {
      md.push(`| ${e.invoiceDocNumber} | ${e.personName} | ${musd(e.commission)} |`);
    }
    md.push(`| | **Total** | **${musd(owedTotal)}** |`);
  }
  md.push('');
  fs.writeFileSync(EMAIL_PATH, md.join('\n'));

  // ── html report ──────────────────────────────────────────────────
  const payrollRows = owed.map((e) => `
    <tr>
      <td>${esc(e.invoiceDocNumber)}</td>
      <td>${esc(e.personName)}</td>
      <td class="num strong">${usd(e.commission)}</td>
    </tr>`).join('');

  const eventRows = findings.events.map((e) => `
    <tr>
      <td>${esc(e.personName)}<span class="sub">${esc(e.reason)}</span></td>
      <td>${esc(e.invoiceDocNumber)}</td>
      <td>${esc(e.paidDate)}</td>
      <td class="num">${usd(e.invoiceAmount)}</td>
      <td class="num strong">${usd(e.commission)}</td>
      <td>${e.paidToEd ? '<span class="pill ok">Paid to Ed</span>' : '<span class="pill due">Owed</span>'}</td>
    </tr>`).join('');

  const pendingRows = findings.pendingInvoices.map((p) => `
    <tr>
      <td>${esc(p.personName)}<span class="sub">${esc(p.reason)}</span></td>
      <td>${esc(p.invoiceDocNumber)}</td>
      <td>${esc(p.invoiceDate)}</td>
      <td class="num">${usd(p.amount)}</td>
      <td class="num">${usd(p.balance)}</td>
      <td class="num">${usd(p.commission)}</td>
    </tr>`).join('');

  const estimateRows = findings.openEstimates.map((e) => `
    <tr>
      <td>${esc(e.personName)}<span class="sub">${esc(e.reason)}</span></td>
      <td>${esc(e.estimateDocNumber)}</td>
      <td>${esc(e.estimateDate)}</td>
      <td>${esc(e.status)}</td>
      <td class="num">${usd(e.amount)}</td>
      <td class="num">${usd(e.commission)}</td>
    </tr>`).join('');

  const rosterRows = findings.roster.map((r) => `
    <tr><td>${esc(r.personName)}</td><td>${esc(r.reason)}</td><td>${r.personId}</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ed commissions — ${runDate}</title>
<style>
  :root { --blue: #1e6fb8; --ink: #1a2330; --mut: #64748b; --line: #e2e8f0; --bg: #f6f8fa; --ok: #15803d; --due: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 24px 20px 60px; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .meta { color: var(--mut); font-size: 13px; }
  .payroll { background: #fff; border: 2px solid var(--blue); border-radius: 10px; padding: 16px 18px 18px; margin: 18px 0 8px; }
  .payroll h2 { margin: 0 0 4px; }
  .payroll table { border-radius: 8px; }
  .chips { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0 26px; }
  .chip { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 18px; min-width: 150px; }
  .chip .v { font-size: 22px; font-weight: 700; }
  .chip .v.blue { color: var(--blue); }
  .chip .k { font-size: 12px; color: var(--mut); text-transform: uppercase; letter-spacing: .04em; }
  h2 { font-size: 16px; margin: 30px 0 4px; }
  .lede { font-size: 13px; color: var(--mut); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--mut); padding: 10px 12px; border-bottom: 2px solid var(--line); background: #fbfcfd; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.strong { font-weight: 700; color: var(--blue); }
  .sub { display: block; font-size: 12px; color: var(--mut); }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
  .pill.ok { color: var(--ok); background: #f0fdf4; border: 1px solid #bbf7d0; }
  .pill.due { color: var(--due); background: #fffbeb; border: 1px solid #fde68a; }
  .empty { color: var(--mut); background: #fff; border: 1px dashed var(--line); border-radius: 10px; padding: 16px; }
  tfoot td { background: #fbfcfd; font-weight: 700; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--blue); font-weight: 600; }
  .note { font-size: 13px; color: var(--mut); margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Ed Crowell — commission report</h1>
    <div class="meta">Run ${esc(findings.runAt)} · rate ${ratePct} of invoice total, earned when the customer pays in full · Pipedrive is the source of truth for attribution</div>
  </header>

  ${owed.length ? `<div class="payroll">
    <h2>For payroll — this cycle</h2>
    <p class="lede">Add a commission payment of <strong>${usd(owedTotal)}</strong> to Ed Crowell's next payroll run.</p>
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th class="num">Commission</th></tr></thead>
      <tbody>${payrollRows}</tbody>
      <tfoot><tr><td colspan="2">Total payable to Ed Crowell</td><td class="num">${usd(owedTotal)}</td></tr></tfoot>
    </table>
  </div>` : ''}

  <div class="chips">
    <div class="chip"><div class="v blue">${usd(owedTotal)}</div><div class="k">Owed to Ed now (${owed.length})</div></div>
    <div class="chip"><div class="v">${usd(paidTotal)}</div><div class="k">Paid to date (${paid.length})</div></div>
    <div class="chip"><div class="v">${usd(pendingTotal)}</div><div class="k">On its way (${findings.pendingInvoices.length} invoices)</div></div>
    <div class="chip"><div class="v">${usd(potentialTotal)}</div><div class="k">Potential (${findings.openEstimates.length} quotes)</div></div>
  </div>

  <h2>Commissions</h2>
  <p class="lede">Every job that has fully paid out. "Owed" rows are what payroll should pick up this cycle.</p>
  ${findings.events.length ? `<table>
    <thead><tr><th>Customer</th><th>Invoice</th><th>Customer paid</th><th class="num">Job total</th><th class="num">Commission</th><th>Status</th></tr></thead>
    <tbody>${eventRows}</tbody>
    <tfoot><tr><td colspan="4">Owed to Ed</td><td class="num">${usd(owedTotal)}</td><td></td></tr></tfoot>
  </table>` : `<div class="empty">No commissions earned yet.</div>`}

  <h2>Pending — invoiced, customer hasn't paid yet</h2>
  <p class="lede">Commissions on their way: the job is done and billed; Ed's cut lands when the customer pays.</p>
  ${findings.pendingInvoices.length ? `<table>
    <thead><tr><th>Customer</th><th>Invoice</th><th>Invoiced</th><th class="num">Job total</th><th class="num">Balance due</th><th class="num">Commission when paid</th></tr></thead>
    <tbody>${pendingRows}</tbody>
    <tfoot><tr><td colspan="5">Total on its way</td><td class="num">${usd(pendingTotal)}</td></tr></tfoot>
  </table>` : `<div class="empty">No outstanding invoices for attributed customers.</div>`}

  <h2>Potential — open quotes, deal not closed</h2>
  <p class="lede">Ed-attributed quotes still on the table. If they close and pay, they become commissions.</p>
  ${findings.openEstimates.length ? `<table>
    <thead><tr><th>Customer</th><th>Quote</th><th>Quoted</th><th>Status</th><th class="num">Quote total</th><th class="num">Commission if closed</th></tr></thead>
    <tbody>${estimateRows}</tbody>
    <tfoot><tr><td colspan="5">Total potential</td><td class="num">${usd(potentialTotal)}</td></tr></tfoot>
  </table>` : `<div class="empty">No open quotes for attributed customers.</div>`}

  <details>
    <summary>Attribution roster — ${findings.attributedCount} contacts</summary>
    <div class="note">Everyone currently attributed to Ed. Most are partner/realtor contacts with no revenue yet; they appear above only when money shows up.</div>
    <table style="margin-top:10px">
      <thead><tr><th>Name</th><th>Why attributed</th><th>PD id</th></tr></thead>
      <tbody>${rosterRows}</tbody>
    </table>
  </details>
</div>
</body>
</html>`;

  fs.writeFileSync(REPORT_PATH, html);
  console.log(`Report -> ${REPORT_PATH}`);
  console.log(`Email  -> ${EMAIL_PATH}`);
}

main();
