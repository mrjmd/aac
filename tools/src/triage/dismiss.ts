#!/usr/bin/env npx tsx
/**
 * Triage dismissal rules (triage:dismissals in Redis, the TriageStore list
 * analyze applies). Replaces hand-editing dismissals.json.
 *
 *   npx tsx tools/src/triage/dismiss.ts list [--all]
 *   npx tsx tools/src/triage/dismiss.ts add "<match>" --reason "..." [--sections quote_gap,cash_not_sent] [--until YYYY-MM-DD] [--dry-run]
 *   npx tsx tools/src/triage/dismiss.ts remove "<match>" [--sections ...] [--dry-run]
 *
 * `match` is checked case-insensitively against a finding's customer, title
 * and phone (use the E.164 phone for a number). `--until` makes it a
 * temporary hold. `list` hides expired holds unless --all. `--dry-run`
 * applies the change to an in-memory copy and prints it; nothing is written.
 */

import {
  MemoryTriageStore,
  RedisTriageStore,
  TRIAGE_SECTIONS,
  addDismissal,
  isRuleActive,
  removeDismissal,
  type DismissalRule,
  type Section,
  type TriageStore,
} from '@aac/triage';
import { loadEnv, redisFromEnv } from '../lib/env';

const USAGE = `usage:
  dismiss.ts list [--all]
  dismiss.ts add "<match>" --reason "..." [--sections a,b] [--until YYYY-MM-DD] [--dry-run]
  dismiss.ts remove "<match>" [--sections a,b] [--dry-run]
sections: ${TRIAGE_SECTIONS.join(', ')}`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value\n${USAGE}`);
  return v;
}

/** analyze compares `until` against the UTC date; addedAt is Matt's (Eastern) calendar day, as the file always had. */
const utcToday = (): string => new Date().toISOString().slice(0, 10);
const easternToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

function show(r: DismissalRule, today: string): string {
  const parts = [r.match];
  if (r.sections) parts.push(`[${r.sections.join(', ')}]`);
  if (r.until) parts.push(`until ${r.until}${isRuleActive(r, today) ? '' : ' (expired)'}`);
  if (r.addedAt) parts.push(`added ${r.addedAt}`);
  return `${parts.join('  ')}${r.reason ? `\n    ${r.reason}` : ''}`;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'list' && cmd !== 'add' && cmd !== 'remove') throw new Error(USAGE);
  loadEnv();
  const redisStore = new RedisTriageStore(redisFromEnv());
  const dryRun = args.includes('--dry-run');
  let store: TriageStore = redisStore;
  if (dryRun) {
    const mem = new MemoryTriageStore();
    mem.dismissals = await redisStore.loadDismissals();
    store = mem;
  }

  if (cmd === 'list') {
    const rules = (await store.loadDismissals()) ?? [];
    const today = utcToday();
    const shown = args.includes('--all') ? rules : rules.filter((r) => isRuleActive(r, today));
    for (const r of shown) console.log(show(r, today));
    console.log(`${shown.length} of ${rules.length} rules${args.includes('--all') ? '' : ' (expired holds hidden; --all to show)'}`);
    return;
  }

  const match = args[0];
  if (!match || match.startsWith('--')) throw new Error(`missing "<match>"\n${USAGE}`);
  const sectionsArg = flag(args, '--sections');
  const sections = sectionsArg ? (sectionsArg.split(',').map((s) => s.trim()) as Section[]) : undefined;
  const prefix = dryRun ? '[dry-run] would ' : '';

  if (cmd === 'add') {
    const reason = flag(args, '--reason');
    if (!reason) throw new Error(`add needs --reason\n${USAGE}`);
    const until = flag(args, '--until');
    const input = { match, reason, ...(sections ? { sections } : {}), ...(until ? { until } : {}) };
    const rules = await addDismissal(store, input, easternToday());
    console.log(`${prefix}add (now ${rules.length} rules):\n  ${show(rules[rules.length - 1] as DismissalRule, utcToday())}`);
    return;
  }

  const removed = await removeDismissal(store, match, sections);
  console.log(`${prefix}remove ${removed.length}:\n${removed.map((r) => `  ${show(r, utcToday())}`).join('\n')}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
