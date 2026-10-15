#!/usr/bin/env npx tsx
/**
 * Triage dashboard — HTML renderer.
 *
 * Reads analysis/data/triage/findings.json, writes analysis/triage.html —
 * a single self-contained page (inline CSS, no CDN) openable via file://.
 * Sections in Matt's priority order; red/yellow/green per the
 * command-center spec thresholds. See docs/projects/triage-dashboard.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Finding, FindingsFile, Section } from './analyze.ts';

const ET = 'America/New_York';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function telLink(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '').replace(/^1/, '');
  const pretty =
    digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
  return `<a class="tel" href="tel:${esc(phone)}">${esc(pretty)}</a>`;
}

const SEV_ORDER = { red: 0, yellow: 1, info: 2 } as const;

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      (b.amount ?? 0) - (a.amount ?? 0) ||
      (b.ageDays ?? 0) - (a.ageDays ?? 0),
  );
}

function card(f: Finding): string {
  const bits: string[] = [];
  if (f.customer && !f.title.includes(f.customer)) bits.push(`<span class="meta">${esc(f.customer)}</span>`);
  if (f.phone) bits.push(telLink(f.phone));
  if (f.link) bits.push(`<a class="tel" href="${esc(f.link)}" target="_blank" rel="noopener">open ✉</a>`);
  if (f.amount) bits.push(`<span class="amt">${usd(f.amount)}</span>`);
  if (f.ageDays !== undefined && f.ageDays > 0) bits.push(`<span class="meta">${f.ageDays}d</span>`);
  bits.push(`<span class="src">${esc(f.source)}${f.confidence ? ` · ${esc(f.confidence)}` : ''}</span>`);
  return `<div class="card sev-${f.severity}" data-fid="${esc(f.id)}">
  <div class="card-head"><input type="checkbox" class="chk" title="Mark handled (visual only — next refresh re-verifies)"><span class="dot"></span><strong>${esc(f.title)}</strong>${bits.join('')}</div>
  ${f.detail ? `<p class="detail">${esc(f.detail)}</p>` : ''}
  ${f.evidence ? `<blockquote>${esc(f.evidence)}</blockquote>` : ''}
  ${f.action ? `<p class="action">→ ${esc(f.action)}</p>` : ''}
</div>`;
}

function staleTable(list: Finding[]): string {
  // Freshest first — recent quotes are the ones a nudge can still save.
  // Amount/Age headers re-sort client-side (see the inline script).
  const rows = [...list]
    .sort((a, b) => (a.ageDays ?? 0) - (b.ageDays ?? 0) || (b.amount ?? 0) - (a.amount ?? 0))
    .map(
      (f) =>
        `<tr class="row-${f.severity}" data-fid="${esc(f.id)}" data-amount="${f.amount ?? 0}" data-age="${f.ageDays ?? 0}"><td class="chkcell"><input type="checkbox" class="chk" title="Mark handled (visual only — next refresh re-verifies)"></td><td>${esc(f.customer ?? '')}</td><td>${telLink(f.phone)}</td><td class="num">${f.amount ? usd(f.amount) : ''}</td><td class="num">${f.ageDays ?? ''}d</td><td>${esc(f.lastContact ?? '')}</td><td>${f.action ? `<span class="nudge">→ ${esc(f.action)}</span>` : ''}</td></tr>`,
    )
    .join('\n');
  return `<div class="tablewrap"><table><thead><tr><th></th><th>Customer / estimate</th><th>Phone</th><th class="num" data-sort="amount">Amount</th><th class="num" data-sort="age" data-dir="asc">Age ▴</th><th>Last text/call</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

interface SectionDef {
  key: Section[];
  title: string;
  blurb: string;
  render?: (list: Finding[]) => string;
}

const SECTIONS: SectionDef[] = [
  {
    key: ['system'],
    title: 'System health',
    blurb: 'Canary checks on the AI plumbing itself. Red here means the detectors below may be flying blind.',
  },
  {
    key: ['booked_gap'],
    title: 'Booked-work gaps',
    blurb: 'Promised or approved work that is NOT on the calendar. Close these first.',
  },
  {
    key: ['incomplete_event'],
    title: 'Incomplete upcoming events',
    blurb: 'Work events in the next 7 days missing an address, a description, or Mike as attendee. Fix these before the morning Mike rolls out (the Shivani-address incident).',
  },
  {
    key: ['stub_review'],
    title: 'Stubs awaiting review',
    blurb: 'Auto-created STUB events from chat bookings. Confirm time, scope, and duration, then rename the event to drop the STUB prefix.',
  },
  {
    key: ['offer_hold'],
    title: 'Offered times on hold',
    blurb: 'Slots offered to customers who have not answered. Nudge them or delete the HOLD event to release the time — every one of these is calendar inventory someone else could book.',
  },
  {
    key: ['quote_promised'],
    title: 'Quotes promised, not sent',
    blurb: 'Matt told someone a quote was coming and no QBO estimate followed. This is deal flow — get these out.',
  },
  {
    key: ['quote_gap'],
    title: 'Assessments without quotes',
    blurb: 'Assessment happened, but no matching estimate (or invoice, or booked job) exists in QBO. Quote them or dismiss.',
  },
  {
    key: ['deal_closer'],
    title: 'Deal-closer replies',
    blurb: 'Approvals and quote questions where one reply likely closes the sale.',
  },
  {
    key: ['cash_not_invoiced', 'cash_not_sent', 'cash_overdue'],
    title: 'Cash flow',
    blurb: 'Work done but not invoiced, invoices never sent, and overdue AR.',
  },
  {
    key: ['stale_estimate'],
    title: 'Stale estimates',
    blurb: 'Pending quotes 3+ days old. Highlighted rows have had no text or call in 3+ days — ready for a nudge.',
    render: staleTable,
  },
  {
    key: ['conversation'],
    title: 'Unresolved conversations',
    blurb: 'SMS and email threads that look like they are waiting on us.',
  },
  {
    key: ['solicitation'],
    title: 'Likely solicitations',
    blurb: 'Vendors selling TO us (lead-gen, SEO, advertising). Lowest tier — skim for misclassified real customers, then ignore. Dismiss by phone if one persists.',
  },
];

function main(): void {
  const dataDir = path.resolve(process.cwd(), 'analysis/data/triage');
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'findings.json'), 'utf8')) as FindingsFile;
  const { findings, pulse } = data;

  const generated = new Date(data.generatedAt).toLocaleString('en-US', {
    timeZone: ET,
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const redCount = findings.filter((f) => f.severity === 'red').length;
  const yellowCount = findings.filter((f) => f.severity === 'yellow').length;
  const overall = redCount > 0 ? 'red' : yellowCount > 0 ? 'yellow' : 'green';

  const pulseTiles = [
    { label: 'Open AR', value: `${usd(pulse.arOpenTotal)} · ${pulse.arOpenCount}`, bad: pulse.arOverdueTotal > 0 },
    { label: 'Overdue AR', value: usd(pulse.arOverdueTotal), bad: pulse.arOverdueTotal > 0 },
    { label: 'Done, not invoiced', value: String(pulse.notInvoicedCount), bad: pulse.notInvoicedCount > 0 },
    { label: 'Approved, unscheduled', value: String(pulse.approvedUnscheduledCount), bad: pulse.approvedUnscheduledCount > 0 },
    { label: 'Stale quotes', value: `${usd(pulse.staleEstimateTotal)} · ${pulse.staleEstimateCount}`, bad: false },
    { label: 'Quotes promised', value: String(pulse.quotePromisedCount ?? 0), bad: (pulse.quotePromisedCount ?? 0) > 0 },
    { label: 'Assessed, unquoted', value: String(pulse.assessedUnquotedCount), bad: pulse.assessedUnquotedCount > 0 },
    { label: 'Stubs to review', value: String(pulse.stubAwaitingReviewCount ?? 0), bad: (pulse.stubAwaitingReviewCount ?? 0) > 0 },
    { label: 'Offers on hold', value: String(pulse.offeredHoldCount ?? 0), bad: (pulse.offeredHoldCount ?? 0) > 0 },
    { label: 'Incomplete next 7d', value: String(pulse.incompleteUpcomingCount ?? 0), bad: (pulse.incompleteUpcomingCount ?? 0) > 0 },
    { label: 'Jobs next 7 / 30d', value: `${pulse.jobsNext7} / ${pulse.jobsNext30}`, bad: pulse.jobsNext7 === 0 },
  ]
    .map(
      (t) =>
        `<div class="tile${t.bad ? ' tile-bad' : ''}"><div class="tile-label">${esc(t.label)}</div><div class="tile-value">${esc(t.value)}</div></div>`,
    )
    .join('\n');

  const sectionsHtml = SECTIONS.map((def) => {
    const list = findings.filter((f) => def.key.includes(f.section));
    const body =
      list.length === 0
        ? '<p class="empty">✓ Nothing here.</p>'
        : def.render
          ? def.render(list)
          : sortFindings(list).map(card).join('\n');
    const worst = list.some((f) => f.severity === 'red') ? 'red' : list.some((f) => f.severity === 'yellow') ? 'yellow' : 'green';
    return `<section>
<h2><span class="pill pill-${list.length === 0 ? 'green' : worst}">${list.length}</span> ${esc(def.title)}</h2>
<p class="blurb">${esc(def.blurb)}</p>
${body}
</section>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AAC Triage — ${esc(data.generatedAt.slice(0, 10))}</title>
<style>
:root { --blue:#1e6fb8; --dark:#1a2332; --red:#c0392b; --yellow:#b7791f; --green:#1e7e46; --line:#e3e6ea; }
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,'Segoe UI',Roboto,sans-serif; color:var(--dark); background:#f6f7f9; }
header { background:var(--dark); color:#fff; padding:20px 28px; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
header h1 { margin:0; font-size:20px; }
header .when { opacity:.75; font-size:13px; }
.status { margin-left:auto; font-weight:700; padding:4px 12px; border-radius:99px; font-size:13px; }
.status-red { background:var(--red); } .status-yellow { background:var(--yellow); } .status-green { background:var(--green); }
main { max-width:960px; margin:0 auto; padding:20px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:8px; }
.tile { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
.tile-bad .tile-value { color:var(--red); }
.tile-label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#78818c; }
.tile-value { font-size:17px; font-weight:700; margin-top:2px; }
section { margin-top:26px; }
h2 { font-size:16px; border-bottom:2px solid var(--blue); padding-bottom:6px; display:flex; align-items:center; gap:8px; }
.pill { border-radius:99px; color:#fff; font-size:12px; padding:1px 9px; }
.pill-red { background:var(--red); } .pill-yellow { background:var(--yellow); } .pill-green { background:var(--green); }
.blurb { color:#5c6672; font-size:13px; margin:4px 0 12px; }
.card { background:#fff; border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:10px; }
.card.sev-red { border-left-color:var(--red); } .card.sev-yellow { border-left-color:var(--yellow); } .card.sev-info { border-left-color:#9aa4af; }
.card-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; font-size:14px; }
.dot { display:none; }
.meta { color:#5c6672; font-size:12px; }
.amt { font-weight:700; color:var(--dark); font-size:13px; }
.src { margin-left:auto; font-size:11px; color:#9aa4af; }
.tel { color:var(--blue); text-decoration:none; font-size:13px; }
.detail { font-size:13px; color:#3d4652; margin:6px 0 0; }
blockquote { margin:8px 0 0; padding:6px 10px; border-left:3px solid var(--blue); background:#f0f5fa; font-size:13px; color:#3d4652; font-style:italic; }
.action { font-size:13px; font-weight:600; color:var(--blue); margin:6px 0 0; }
.empty { color:var(--green); font-size:14px; }
.chk { width:16px; height:16px; accent-color:var(--green); cursor:pointer; flex:none; align-self:center; }
.chkcell { width:28px; }
.card.done { opacity:.45; }
.card.done .card-head strong, .card.done .detail, .card.done .action { text-decoration:line-through; }
tr.done td { opacity:.45; }
tr.done td:not(.chkcell) { text-decoration:line-through; }
.tablewrap { overflow-x:auto; background:#fff; border:1px solid var(--line); border-radius:8px; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th,td { text-align:left; padding:7px 12px; border-bottom:1px solid var(--line); }
th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#78818c; }
td.num,th.num { text-align:right; }
tr.row-yellow td { background:#fdf6e7; }
.nudge { color:var(--yellow); font-weight:600; font-size:12px; white-space:nowrap; }
th[data-sort] { cursor:pointer; user-select:none; }
th[data-sort]:hover { color:var(--blue); }
footer { color:#9aa4af; font-size:12px; margin:34px 0 20px; text-align:center; }
@media print { header { -webkit-print-color-adjust:exact; } }
</style>
</head>
<body>
<header>
  <h1>Attack A Crack — Triage</h1>
  <span class="when">${esc(generated)} ET</span>
  <span class="status status-${overall}">${redCount} red · ${yellowCount} yellow</span>
</header>
<main>
<div class="tiles">
${pulseTiles}
</div>
${sectionsHtml}
<footer>
  Snapshot ${esc(data.snapshotAt)} · ${esc(String(data.stats.threads ?? 0))} threads + ${esc(String(data.stats.emailThreads ?? 0))} email threads swept, ${esc(String(data.stats.llmThreads ?? 0))} LLM-triaged (${esc(String(data.stats.llmErrors ?? 0))} errors) ·
  regen: <code>./tools/src/triage/refresh.sh</code> · doc: docs/projects/triage-dashboard.md
</footer>
</main>
<script>
// Sortable table headers (stale estimates): click to sort by that column,
// click again to flip direction. Amount starts big-first, Age starts fresh-first.
document.querySelectorAll('th[data-sort]').forEach(function (th) {
  th.addEventListener('click', function () {
    var key = th.dataset.sort;
    var defaults = { amount: 'desc', age: 'asc' };
    var dir = th.dataset.dir ? (th.dataset.dir === 'asc' ? 'desc' : 'asc') : defaults[key];
    var headRow = th.parentElement;
    headRow.querySelectorAll('th[data-sort]').forEach(function (h) {
      delete h.dataset.dir;
      h.textContent = h.textContent.replace(/ [▴▾]$/, '');
    });
    th.dataset.dir = dir;
    th.textContent += dir === 'asc' ? ' ▴' : ' ▾';
    var tbody = th.closest('table').querySelector('tbody');
    Array.from(tbody.rows)
      .sort(function (a, b) {
        return (dir === 'asc' ? 1 : -1) * (Number(a.dataset[key]) - Number(b.dataset[key]));
      })
      .forEach(function (r) { tbody.appendChild(r); });
  });
});

// Check-off strikethrough: purely visual progress tracking while working the
// list. State lives in localStorage keyed by this snapshot's generatedAt, so
// every fresh triage run starts unchecked — anything that didn't actually get
// done is re-detected and reappears. Old generations' keys are pruned.
(function () {
  var KEY = 'triage-done:${esc(data.generatedAt)}';
  Object.keys(localStorage).forEach(function (k) {
    if (k.indexOf('triage-done:') === 0 && k !== KEY) localStorage.removeItem(k);
  });
  var done = {};
  try { done = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  document.querySelectorAll('[data-fid]').forEach(function (el) {
    var cb = el.querySelector('.chk');
    if (!cb) return;
    if (done[el.dataset.fid]) { cb.checked = true; el.classList.add('done'); }
    cb.addEventListener('change', function () {
      el.classList.toggle('done', cb.checked);
      if (cb.checked) done[el.dataset.fid] = 1; else delete done[el.dataset.fid];
      localStorage.setItem(KEY, JSON.stringify(done));
    });
  });
})();
</script>
</body>
</html>
`;

  const outPath = path.resolve(process.cwd(), 'analysis/triage.html');
  fs.writeFileSync(outPath, html);
  console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(0)}KB)`);
}

main();
