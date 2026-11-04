#!/usr/bin/env npx tsx
/**
 * Seed the can-help standing rules + referral list into Redis (thin wrapper
 * over CanHelpStore). Source: analysis/02-strategy/decline-patterns-2026-11.md
 * and Matt's decisions on 2026-11-04. Skips ids that already exist, so edits
 * made in the command center are never overwritten. --dry-run prints only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { CanHelpStore, type Referral, type StandingRule } from '@aac/quoting';

const REFERRALS: Referral[] = [
  { id: 'best-bulkheads', name: 'Henry at Best Bulkheads', phone: '(781) 801-8188', sends: 'Bulkhead doors, hatches, frames, full bulkhead replacement, removal or dig-out.' },
  { id: 'air-guardian', name: 'Tanner at Air Guardian', sends: 'Exterior waterproofing and excavation, interior drains and sump systems, leaking cinder block walls.' },
  { id: 'atlas', name: 'Andrew Geisser at Atlas Systems', phone: '(508) 243-0248', sends: 'Major structural foundation work: failing or displaced walls, active movement.' },
  { id: 'aja', name: 'Aboud Alzaim at AJA Engineering', phone: '(339) 222-7594', sends: 'Structural engineer: bowing walls, movement, anything that needs an engineering opinion first.' },
  { id: 'structural-hd', name: 'James Geary at Structural HD', phone: '(978) 835-9700', sends: 'Structural engineer: bowing walls, retaining walls, structural assessments.' },
  { id: 'ram-jack', name: 'Ram Jack New England', phone: '(508) 426-8029', sends: 'Leveling and lifting: sunken slabs, steps, settling (mudjacking, polyjacking, piers).' },
  { id: 'eft', name: 'EFT', phone: '603-598-0089', sends: 'House leveling.' },
  { id: 'mrw-masonry', name: 'MRW Masonry', phone: '(617) 412-7696', sends: 'Brick foundations and brickwork.' },
  { id: 'old-colony', name: 'Jay Casey at Old Colony Masons', phone: '(857) 249-5837', sends: 'Large stone/fieldstone repointing, brick, masonry rebuilds, excavation.' },
  { id: 'knights-masonry', name: "Knight's Masonry", phone: '(617) 777-9198', sends: 'Stone and fieldstone repointing.' },
  { id: 'boston-budget-plumbing', name: 'Boston Budget Plumbing', sends: 'Sump pumps, plumbing and water main leaks.' },
  { id: 'luc', name: 'Luc (Attack A Crack Connecticut)', phone: '860-573-8760', sends: 'Connecticut properties.' },
];

const RULES: StandingRule[] = [
  { id: 'leaking-block', kind: 'decline', text: 'Leaking cinder block / CMU walls, including block bulkhead stairwells (hollow blocks: inside injection does not stop the water). NOT leaking block stair-step cracks, which we fix with carbon fiber staples or repointing.', referralIds: ['air-guardian', 'boston-budget-plumbing'], since: '2026-11-04' },
  { id: 'leaking-parged-stone-bulkhead', kind: 'decline', text: 'Parged-block or stone bulkhead that is actively leaking (a crack of concern with no water is fine).', referralIds: ['air-guardian'], since: '2026-11-04' },
  { id: 'bulkhead-doors', kind: 'decline', text: 'Bulkhead doors, hatches, frames, replacement, removal or dig-out (we do inject the concrete seam of a precast/poured bulkhead).', referralIds: ['best-bulkheads'], since: '2025-03-01' },
  { id: 'brick', kind: 'decline', text: 'Brick foundations and brickwork, or mixed brick/block walls (injection does not work with brick).', referralIds: ['mrw-masonry', 'old-colony'], since: '2025-06-01' },
  { id: 'structural', kind: 'decline', text: 'Structural work beyond repair: bowing over about 1.5 inches, active movement, severe displacement, exposed rebar, failing walls.', referralIds: ['aja', 'structural-hd', 'atlas'], since: '2024-09-01' },
  { id: 'leveling', kind: 'decline', text: 'Leveling or lifting sunken slabs, steps, pavers or a house (we can grind trip edges of about 1/2 inch or less).', referralIds: ['ram-jack', 'eft'], since: '2025-05-01' },
  { id: 'new-pours', kind: 'decline', text: 'New pours, demo-and-rebuild, or full replacement of driveways, sidewalks, slabs, aprons, walkways or foundations.', since: '2024-11-01' },
  { id: 'water-no-crack', kind: 'decline', text: 'Water problems with no crack to fix: grading, gutters, downspouts, French drains, vapor coming up through the slab, water over the sill. (If there is also a real crack, quote the crack and refer the rest.)', referralIds: ['air-guardian', 'boston-budget-plumbing'], since: '2025-03-01' },
  { id: 'stone-large', kind: 'decline', text: 'Large-scale stone/fieldstone repointing or fieldstone leaking across a whole wall.', referralIds: ['old-colony', 'knights-masonry'], since: '2025-03-01' },
  { id: 'trades', kind: 'decline', text: 'Non-concrete trades: wood beams, joists, lally columns, chimneys, drywall patching, standalone painting, tile, railings, pool plaster, stamped concrete, mold, concrete cutting.', since: '2024-09-01' },
  { id: 'asphalt', kind: 'decline', text: 'Asphalt of any kind (we only work with concrete).', since: '2025-01-01' },
  { id: 'too-small', kind: 'decline', text: 'Jobs below our $375 trip minimum: decline kindly with a DIY tip (e.g. Sikaflex).', since: '2024-09-01' },
  { id: 'out-of-area', kind: 'decline', text: 'Outside our service area (western CT, Nantucket, out of state). Connecticut properties go to Luc.', referralIds: ['luc'], since: '2025-06-01' },
  { id: 'special-risk', kind: 'decline', text: 'Balconies (insurance), drive-on structural decks or carports, heavy-machinery commercial floors.', since: '2025-05-01' },
  { id: 'resurfacing-pause', kind: 'policy', text: 'Not taking on large square-footage concrete resurfacing (full garages, pool decks, big patios or driveways). Stairs and small panels are fine. Offer to follow up then.', since: '2026-10-21', untilWhen: 'tech #2 starts, possibly spring', reviewBy: '2027-03-01' },
];

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]!] ??= m[2]!.replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  loadEnv();
  const dryRun = process.argv.includes('--dry-run');
  const store = new CanHelpStore(
    new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }),
  );
  const haveRefs = new Set((await store.referrals()).map((r) => r.id));
  const haveRules = new Set((await store.rules()).map((r) => r.id));
  for (const r of REFERRALS) {
    if (haveRefs.has(r.id)) continue;
    console.log(`referral + ${r.id}`);
    if (!dryRun) await store.putReferral(r);
  }
  for (const r of RULES) {
    if (haveRules.has(r.id)) continue;
    console.log(`rule + ${r.id}`);
    if (!dryRun) await store.putRule(r);
  }
  if (dryRun) console.log('\n' + (await import('@aac/quoting')).buildCanHelpBlock({ rules: RULES, referrals: REFERRALS, today: new Date().toISOString().slice(0, 10) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
