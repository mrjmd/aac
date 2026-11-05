import type { Item } from './types.js';

/**
 * One person = one item (Matt, 2026-11-05). Rob O'Neil showed up four times
 * (text thread, failed bot draft, two emails); this folds a person's items
 * under the strongest one. Identity is any shared phone, email, triage
 * identity cluster, or full name (two or more words). A confirm-lane item
 * (e.g. the drafted intake reply) folds under that person's needs-you item
 * but never leads a group; with no needs-you item it stays in its lane.
 */

const BAND_ORDER = { today: 0, new: 1, list: 2 } as const;

/** Display names that aren't identities: "Lead (·3964)", "Sarah (·8286)", bare numbers. */
function nameKey(customer: string | undefined): string | null {
  if (!customer) return null;
  const words = customer
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-z']+/)
    .filter((w) => w.length >= 2 && w !== 'lead' && w !== 'mrs' && w !== 'mr');
  return words.length >= 2 ? `name:${words.join(' ')}` : null;
}

export function identityKeys(item: Item): string[] {
  const out = new Set<string>();
  for (const p of [item.phone, ...(item.who?.phones ?? [])]) if (p) out.add(`phone:${p}`);
  for (const e of item.who?.emails ?? []) out.add(`email:${e.toLowerCase()}`);
  if (item.who?.cluster) out.add(`cluster:${item.who.cluster}`);
  const n = nameKey(item.customer);
  if (n) out.add(n);
  return [...out];
}

/** Which item leads a group: Today beats New beats the list, then the higher score. */
function better(a: Item, b: Item): boolean {
  if (a.band !== b.band) return BAND_ORDER[a.band] < BAND_ORDER[b.band];
  return a.score > b.score;
}

/** Group items by person. Input order is kept for the leads. Pure. */
export function groupByPerson(items: Item[]): Item[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(find(b), find(a));
  };

  const root = new Map<string, string>(); // item key → its first identity key
  for (const item of items) {
    if (item.solicitation) continue;
    const ids = identityKeys(item);
    if (!ids.length) continue;
    for (const id of ids) if (!parent.has(id)) parent.set(id, id);
    for (const id of ids.slice(1)) union(ids[0], id);
    root.set(item.key, ids[0]);
  }

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const r = root.get(item.key);
    if (!r) continue;
    const g = find(r);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }

  const leadOf = new Map<string, Item>(); // member key → its group's lead (with related attached)
  for (const members of groups.values()) {
    const leaders = members.filter((m) => m.lane === 'needs-you');
    if (members.length < 2 || !leaders.length) continue;
    const lead = leaders.reduce((a, b) => (better(b, a) ? b : a));
    const top = members.reduce((a, b) => (b.score > a.score ? b : a));
    const related = members.filter((m) => m !== lead);
    const merged: Item = {
      ...lead,
      related,
      score: top.score,
      why: top.why,
    };
    for (const m of members) leadOf.set(m.key, merged);
  }

  const out: Item[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const lead = leadOf.get(item.key);
    if (!lead) {
      out.push(item);
      continue;
    }
    if (seen.has(lead.key)) continue;
    seen.add(lead.key);
    out.push(lead);
  }
  return out;
}
