#!/usr/bin/env npx tsx
/**
 * One-time seed for the command center's People page: Mike and Ed with the
 * agenda, history and facts Matt approved in the mockup (11/03). Skips
 * anyone already present by name, so re-running is safe.
 *
 *   npx tsx tools/src/people/seed.ts [--dry-run]
 */

import { loadEnv, redisFromEnv } from '../lib/env';
import { addTopic, newPerson, PeopleStore, setFacts, type Person, type PersonEvent, type TopicStatus } from '@aac/items';

loadEnv();

interface Seed {
  name: string;
  role: string;
  since: string;
  when: string;
  facts: Array<[string, string]>;
  history: PersonEvent[];
  topics: Array<{ title: string; why: string; status: TopicStatus }>;
}

const SEEDS: Seed[] = [
  {
    name: 'Mike',
    role: 'Tech',
    since: 'Since Jul 2024',
    when: 'Before Friday payroll',
    facts: [
      ['Role', 'Field tech, solo crew'],
      ['Pay', '$60k since May 26'],
      ['Truck repayment', '$3,152.55 left'],
      ['Collects', 'Checks and cash in the field'],
    ],
    history: [
      { at: '2026-06-04', kind: 'text', title: 'Your recap text: cash OK with a heads-up text first', detail: 'The rule the new one replaces' },
      { at: '2026-05-04', kind: 'call', title: 'Call, 9 min: the $320 ATM pull', detail: 'Cash to a mechanic friend for his car. Offered receipts. You said all good.' },
      { at: '2025-10-30', kind: 'text', title: 'Personal charges on the business card', detail: 'He owned it and repaid.' },
    ],
    topics: [
      { title: 'Customer cash that never reached the bank', status: 'ready', why: "Carl Dentler $1,675 (QBO 6/19) and Geoff $575 (9/28, you OK'd once). No Beacon cash deposits after 5/26." },
      { title: 'ATM withdrawals, $1,720 Mar-May', status: 'prep', why: '6 pulls on the Beacon card. $320 explained on the 5/4 call (his car). 5 left; Beacon can name the card from terminal IDs.' },
      { title: 'New rule: no cash, checks deposited by Friday', status: 'ready', why: 'Your 6/4 recap allowed cash with a heads-up text. This replaces it.' },
    ],
  },
  {
    name: 'Ed',
    role: 'Partner channel',
    since: 'Realtor and partner referrals',
    when: 'By Nov 30',
    facts: [
      ['Role', 'Realtor and partner outreach'],
      ['Pay', 'Base + 20% commission'],
      ['Decision', 'Spring 2027, keep or cut'],
      ['Texts', 'His cell, line to line (not a customer)'],
    ],
    history: [
      { at: '2026-11-02', kind: 'note', title: 'You set the keep-or-cut decision for spring 2027', detail: "Judged on his channel row: his cost against his channel's revenue" },
      { at: '2026-09-30', kind: 'note', title: 'Commission report set up', detail: '20% of a paid invoice, only after the money is in the bank' },
    ],
    topics: [
      { title: 'Spring keep-or-cut: the five KPI floors', status: 'prep', why: 'Partners, meetings, attributed leads, pipeline, closed-won. He should hear the bar now, not in March.' },
      { title: 'Commission waits for money in the bank', status: 'ready', why: '$195 held on Kowalski until the check is deposited.' },
    ],
  },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const store = new PeopleStore(redisFromEnv());
  const existing = await store.list();
  const now = new Date();
  let order = (existing.at(-1)?.order ?? -1) + 1;
  for (const s of SEEDS) {
    if (existing.some((p) => p.name.toLowerCase() === s.name.toLowerCase())) {
      console.log(`skip ${s.name}: already there`);
      continue;
    }
    let p: Person = { ...newPerson(s, order++, now), when: s.when, history: s.history };
    p = setFacts(p, s.facts);
    for (const t of s.topics) p = addTopic(p, t, now);
    console.log(`${dryRun ? 'would add' : 'add'} ${p.name}: ${p.topics.length} topics, ${p.history.length} history`);
    if (!dryRun) await store.put(p);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
