#!/usr/bin/env npx tsx
/**
 * Ingest bank CSV exports, categorize transactions, and reconcile against
 * the QBO Purchase entities to find OpEx that's in the bank but missing
 * from QuickBooks. This is the workaround for AAC's 2026 categorization
 * backlog.
 *
 * Reads:  analysis/data/bank/<year>/*.csv
 * Reads:  analysis/data/qbo/entity-purchase.json   (for reconciliation)
 * Writes: analysis/data/bank-reconciled/transactions.json
 * Writes: analysis/data/bank-reconciled/monthly-by-category.json
 * Writes: analysis/data/bank-reconciled/uncategorized.json
 * Writes: analysis/data/bank-reconciled/summary.md
 *
 * Usage:
 *   npx tsx tools/src/analysis/ingest-bank.ts
 */

import fs from 'node:fs';
import path from 'node:path';

interface BankRow {
  postedDate: string;       // ISO
  monthKey: string;         // YYYY-MM
  type: string;             // withdrawal | deposit | fee
  description: string;      // bank-cleaned merchant name
  rawDescription: string;   // verbose POS line
  amount: number;           // signed (negative = withdrawal)
  balance: number;
  category: string;         // assigned
  matchedRule: string;      // why we assigned this category
  sourceFile: string;
}

// ── Categorization rules ─────────────────────────────────────────────
// Order matters — first match wins. Patterns are case-insensitive
// substring matches against `description + ' ' + rawDescription`.

interface Rule {
  pattern: RegExp;
  category: string;
}

const RULES: Rule[] = [
  // Payroll (Datapay is AAC's payroll provider)
  { pattern: /datapay.*tax impoun|tax impoun/i, category: 'Payroll (Taxes)' },
  { pattern: /datapay.*obc impoun|obc impoun/i, category: 'Payroll (Wages Impound)' },
  { pattern: /datapay.*billing|datapay inc(?!.*impoun)|datapay$/i, category: 'Payroll (Processing Fees)' },
  { pattern: /datapay/i, category: 'Payroll (Other)' },
  { pattern: /payroll|gusto|adp|paychex|justworks/i, category: 'Payroll' },

  // Payment processors / merchant fees
  { pattern: /intuit.*(tran fee|payments)/i, category: 'Payment Processing' },
  { pattern: /quickbooks/i, category: 'Software (QuickBooks)' },
  { pattern: /paypal/i, category: 'Payment Processing' },

  // Marketing & lead-gen
  { pattern: /google ads|googleads/i, category: 'Advertising (Google Ads)' },
  { pattern: /yelp|angi|thumbtack|home ?advisor|networx|porch\.com|houzz/i, category: 'Advertising (Lead Marketplaces)' },
  { pattern: /facebook|meta platforms/i, category: 'Advertising (Meta)' },
  { pattern: /authority builders|nextdoor/i, category: 'Marketing (Other)' },
  { pattern: /semrush|ahrefs|moz\.com|zoominfo|propertyradar|batchlead|batch.*lead/i, category: 'Marketing (Data/SEO Tools)' },
  { pattern: /mailchimp|constant contact|sendgrid|klaviyo|alignable/i, category: 'Marketing (Email/Network)' },
  { pattern: /peoplelinx|linkedin.*sales|sales navigator/i, category: 'Marketing (Sales Tools)' },
  { pattern: /canva|moo print|moo\.com|vistaprint|printful/i, category: 'Marketing (Design/Print)' },
  { pattern: /eventbrite|chamber of comm|realtors|networking/i, category: 'Marketing (Events/Networking)' },

  // Materials / COGS
  { pattern: /home depot|lowes|lowe'?s|menards|ace hardware/i, category: 'Materials (Hardware Store)' },
  { pattern: /concrete materials|sika|quikrete|sakrete|simpson strong|grainger|smooth.?on|chas e phipps|phipps co|patcz/i, category: 'Materials (Specialty)' },
  { pattern: /(masonry|polymer|epoxy|polyurethane|injection) supply/i, category: 'Materials (Specialty)' },

  // Vehicle / fuel
  // Anchored / specific to avoid matching "Mobile Check Dep", "BP" inside merchant codes, etc.
  { pattern: /\bshell service|\bsunoco\b|exxonmobil|\bexxon\b|chevron station|cumberland farms|\bcitgo\b|\bvalero\b|7-?eleven|\bspeedway\b|gas station/i, category: 'Vehicle (Fuel)' },
  { pattern: /jiffy lube|valvoline|monro|firestone|midas|auto.*repair|parts.*auto|napa auto/i, category: 'Vehicle (Maintenance)' },
  { pattern: /e-?z ?pass|ezpassma|toll/i, category: 'Vehicle (Tolls)' },
  { pattern: /uhaul|u-haul|enterprise.*rent|hertz|budget rent/i, category: 'Vehicle (Rental)' },

  // Software / subscriptions
  { pattern: /claude\.ai|anthropic|openai|chatgpt|cursor\.sh|github|notion|figma|vercel|adobe|microsoft 365|m365|office 365|google.*workspace|gsuite|godaddy|namecheap|cloudflare|digitalocean|google cloud/i, category: 'Software (SaaS)' },
  { pattern: /apple\.com\/bill|app store|itunes/i, category: 'Software (Apple)' },
  { pattern: /pipedrive|hubspot|salesforce|zoho|monday\.com/i, category: 'Software (CRM)' },
  { pattern: /openphone|twilio|ringcentral/i, category: 'Software (Telephony)' },

  // Insurance (incl. premium financing — IPFS — and claim reimbursements)
  { pattern: /hiscox|next insurance|biberk|the hartford|geico.*comm|progressive|workers.*comp|liability insurance|westguard|west.?guard|ipfs corp|safetyins|safety insurance/i, category: 'Insurance' },

  // Taxes
  { pattern: /irs|us treasury|mass.*dor|dept.*revenue|tax.*payment/i, category: 'Taxes' },

  // Bank / financial
  { pattern: /maintenance fee|service charge|overdraft|nsf fee|wire fee|transfer fee/i, category: 'Bank Fees' },
  { pattern: /(?:^|\s)atm(?:\s|$)|atm withdrawal|atm fee/i, category: 'ATM' },

  // Recruiting
  { pattern: /indeed|ziprecruiter|linkedin.*jobs|glassdoor.*hire/i, category: 'Recruiting' },
  { pattern: /quality resource|background check|checkr/i, category: 'Recruiting (Background Check)' },

  // Professional services
  { pattern: /accountant|cpa|bookkeep|legalzoom|attorney|law firm|legal services|asheville leg|asheville legal/i, category: 'Professional Fees' },
  { pattern: /ncourt|maconsumer|hic|town of|city of|massachusetts.*license|sec of ma|secretary of state|corporate filings|permit/i, category: 'Permits & Licensing' },

  // Contract labor / 1099
  { pattern: /venmo|cash app|zelle/i, category: 'Possible Contract Labor (P2P)' },

  // Equipment & tools
  { pattern: /harbor freight|northern tool|toolbarn|acme tools/i, category: 'Tools & Equipment' },

  // Office / supplies / shipping
  { pattern: /staples|office depot|amazon|amzn|uline/i, category: 'Office / Supplies' },
  { pattern: /us postal|usps|ups\b|fedex/i, category: 'Shipping' },

  // Cash
  { pattern: /cash withdrawal|^check #|atm withdrawal/i, category: 'Cash / Check (manual review)' },

  // Travel / meals
  { pattern: /marriott|hilton|hyatt|airbnb|hotel/i, category: 'Travel (Lodging)' },
  { pattern: /delta air|american air|united air|jetblue|southwest air/i, category: 'Travel (Air)' },
  { pattern: /uber\b|lyft\b/i, category: 'Travel (Rideshare)' },
  { pattern: /dunkin|starbucks|chipotle|panera|restaurant|grubhub|doordash|ubereats/i, category: 'Meals' },

  // Utilities & rent
  { pattern: /national grid|eversource|nstar|verizon|att|t-mobile|tmobile|comcast|xfinity|spectrum/i, category: 'Utilities' },
  { pattern: /storage|self storage|public storage|extra space/i, category: 'Storage / Rent' },

  // Income / deposits
  { pattern: /intuit.*deposit|qb payments deposit|merchant deposit|stripe.*payout|paypal.*deposit/i, category: 'Revenue (Card Payments)' },
  { pattern: /mobile check dep|mobile.*deposit|check deposit|checking deposit|deposit.*mobile/i, category: 'Revenue (Check Deposit)' },
  { pattern: /deposit adj/i, category: 'Deposit Adjustment' },
];

// ── CSV parser (the bank format is regular) ──────────────────────────

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  let cell = '';
  let row: string[] = [];
  let inQuotes = false;
  while (i < content.length) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    cell += c; i++;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// ── Categorizer ──────────────────────────────────────────────────────

function categorize(description: string, rawDescription: string, type: string): { category: string; matchedRule: string } {
  const haystack = `${description} ${rawDescription}`;
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { category: rule.category, matchedRule: rule.pattern.source };
    }
  }
  // type-based fallback
  if (type === 'deposit') return { category: 'Revenue (Uncategorized Deposit)', matchedRule: 'type=deposit fallback' };
  if (type === 'fee') return { category: 'Bank Fees', matchedRule: 'type=fee fallback' };
  return { category: 'UNCATEGORIZED', matchedRule: 'no rule matched' };
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = process.cwd();
  const bankDir = path.resolve(projectRoot, 'analysis/data/bank');
  const outDir = path.resolve(projectRoot, 'analysis/data/bank-reconciled');
  fs.mkdirSync(outDir, { recursive: true });

  // Walk bankDir for CSVs
  const csvPaths: string[] = [];
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.csv')) csvPaths.push(p);
    }
  }
  walk(bankDir);
  console.log(`Found ${csvPaths.length} CSV file(s)`);

  const txns: BankRow[] = [];
  for (const file of csvPaths) {
    const content = fs.readFileSync(file, 'utf8');
    const rows = parseCsv(content);
    const header = rows[0];
    const idx = {
      postedDate: header.indexOf('Posted Date'),
      type: header.indexOf('Type'),
      description: header.indexOf('Description'),
      amount: header.indexOf('Amount'),
      balance: header.indexOf('Balance'),
      rawDescription: header.indexOf('Raw Description'),
    };
    if (idx.postedDate < 0 || idx.amount < 0) {
      console.warn(`Skipping ${path.basename(file)} — unexpected schema`);
      continue;
    }
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.length < 2 || !row[idx.postedDate]) continue;
      const dateStr = row[idx.postedDate];
      const monthKey = dateStr.slice(0, 7);
      const description = row[idx.description] ?? '';
      const rawDescription = row[idx.rawDescription] ?? '';
      const type = row[idx.type] ?? '';
      const { category, matchedRule } = categorize(description, rawDescription, type);
      txns.push({
        postedDate: dateStr,
        monthKey,
        type,
        description,
        rawDescription,
        amount: parseFloat(row[idx.amount]) || 0,
        balance: parseFloat(row[idx.balance]) || 0,
        category,
        matchedRule,
        sourceFile: path.basename(file),
      });
    }
  }

  console.log(`Parsed ${txns.length} transactions`);

  // De-dupe (same date + amount + description appearing in multiple CSVs)
  const seen = new Set<string>();
  const deduped = txns.filter((t) => {
    const k = `${t.postedDate}|${t.amount}|${t.description}|${t.balance}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`After de-dupe: ${deduped.length} (${txns.length - deduped.length} duplicates removed)`);

  // Sort newest first
  deduped.sort((a, b) => b.postedDate.localeCompare(a.postedDate));

  // ── Monthly by category pivot ──────────────────────────────────
  const months = [...new Set(deduped.map((t) => t.monthKey))].sort();
  const categories = [...new Set(deduped.map((t) => t.category))].sort();
  const pivot: Record<string, Record<string, number>> = {};
  for (const cat of categories) {
    pivot[cat] = {};
    for (const m of months) pivot[cat][m] = 0;
  }
  for (const t of deduped) {
    pivot[t.category][t.monthKey] += t.amount;
  }

  // ── Uncategorized list (high priority for rule-building) ───────
  const uncategorized = deduped
    .filter((t) => t.category === 'UNCATEGORIZED')
    .map((t) => ({
      date: t.postedDate.slice(0, 10),
      amount: t.amount,
      description: t.description,
      rawDescription: t.rawDescription,
    }));
  const uncategorizedTotal = uncategorized.reduce((s, t) => s + Math.abs(t.amount), 0);

  // ── Spend by category (totals) ─────────────────────────────────
  const totals: Array<{ category: string; outflow: number; inflow: number; net: number; count: number }> = [];
  for (const cat of categories) {
    const list = deduped.filter((t) => t.category === cat);
    const outflow = list.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    const inflow = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    totals.push({ category: cat, outflow, inflow, net: inflow - outflow, count: list.length });
  }
  totals.sort((a, b) => b.outflow - a.outflow);

  // ── Write outputs ──────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'transactions.json'), JSON.stringify(deduped, null, 2));
  fs.writeFileSync(path.join(outDir, 'monthly-by-category.json'), JSON.stringify({ months, categories, pivot }, null, 2));
  fs.writeFileSync(path.join(outDir, 'uncategorized.json'), JSON.stringify(uncategorized, null, 2));
  fs.writeFileSync(path.join(outDir, 'totals-by-category.json'), JSON.stringify(totals, null, 2));

  // ── Markdown summary ───────────────────────────────────────────
  const summary: string[] = [];
  summary.push(`# Bank Reconciliation Summary`);
  summary.push(``);
  summary.push(`Generated: ${new Date().toISOString()}`);
  summary.push(`Source CSVs: ${csvPaths.length}`);
  summary.push(`Total transactions: ${deduped.length}`);
  summary.push(`Period: ${months[0]} → ${months[months.length - 1]}`);
  summary.push(`Uncategorized: ${uncategorized.length} txns / $${uncategorizedTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} absolute volume`);
  summary.push(``);
  summary.push(`## Top categories by outflow (whole period)`);
  summary.push(``);
  summary.push(`| Category | Outflow | Inflow | Net | # txns |`);
  summary.push(`|---|---:|---:|---:|---:|`);
  for (const t of totals.slice(0, 25)) {
    summary.push(`| ${t.category} | $${t.outflow.toLocaleString(undefined, { maximumFractionDigits: 0 })} | $${t.inflow.toLocaleString(undefined, { maximumFractionDigits: 0 })} | $${t.net.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ${t.count} |`);
  }
  summary.push(``);
  summary.push(`## Monthly outflow by top category`);
  summary.push(``);
  const topCats = totals.slice(0, 10).map((t) => t.category);
  summary.push(`| Month | ${topCats.join(' | ')} |`);
  summary.push(`|${'---|'.repeat(topCats.length + 1)}`);
  for (const m of months) {
    const row = [m];
    for (const cat of topCats) {
      const v = pivot[cat][m];
      row.push(v === 0 ? '—' : `\\$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    }
    summary.push(`| ${row.join(' | ')} |`);
  }
  summary.push(``);
  summary.push(`## Uncategorized (top 30 by absolute amount)`);
  summary.push(``);
  summary.push(`These need new rules in \`tools/src/analysis/ingest-bank.ts\` RULES, or manual review:`);
  summary.push(``);
  summary.push(`| Date | Amount | Description | Raw |`);
  summary.push(`|---|---:|---|---|`);
  const topUncat = [...uncategorized].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 30);
  for (const u of topUncat) {
    summary.push(`| ${u.date} | $${u.amount.toFixed(2)} | ${u.description} | \`${u.rawDescription.slice(0, 80)}\` |`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary.join('\n') + '\n');

  console.log(`\nWrote ${path.relative(projectRoot, outDir)}/`);
  console.log(`  transactions.json (${deduped.length} rows)`);
  console.log(`  monthly-by-category.json`);
  console.log(`  uncategorized.json (${uncategorized.length} rows, $${uncategorizedTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume)`);
  console.log(`  totals-by-category.json`);
  console.log(`  summary.md`);
  console.log(`\nCategorization coverage: ${(100 * (deduped.length - uncategorized.length) / deduped.length).toFixed(1)}%`);
}

main();
