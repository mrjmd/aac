#!/usr/bin/env npx tsx
/**
 * Pull the full Matt <-> Ed line-to-line Quo thread.
 * Matt's line: +16176681677 (Massachusetts). Ed's line: +13392175091.
 * Writes analysis/data/commissions/ed-thread.json (oldest first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { QuoClient, type QuoMessage } from '@aac/api-clients/quo';

function loadEnv(): void {
  const raw = fs.readFileSync(path.resolve(process.cwd(), '.env.diagnostic'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const MATT_LINE_ID = 'PNrYTA5wZL'; // +16176681677 Massachusetts
const ED_LINE = '+13392175091';

async function main() {
  const quo = new QuoClient({ apiKey: process.env.QUO_API_KEY!, phoneNumber: process.env.QUO_PHONE_NUMBER! });
  const all: QuoMessage[] = [];
  let pageToken: string | undefined;
  do {
    const page: any = await quo.listMessages({ participantE164: ED_LINE, phoneNumberId: MATT_LINE_ID, maxResults: 100, pageToken });
    all.push(...(page.data ?? []));
    pageToken = page.nextPageToken ?? undefined;
    console.error(`...${all.length}`);
  } while (pageToken);
  all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const out = 'analysis/data/commissions/ed-thread.json';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(all, null, 1));
  console.error(`total ${all.length} messages -> ${out}`);
  if (all.length) console.error('range:', all[0].createdAt, '->', all[all.length - 1].createdAt);
}
main().catch((e) => { console.error(e); process.exit(1); });
