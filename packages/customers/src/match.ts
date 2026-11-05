/**
 * Customer name matching: the one home for "does this text name this
 * customer?". Address identity lives in @aac/shared-utils/address.
 *
 * Modes, strictest first. Pick by what a false match costs:
 * - `summaryMatchesCustomer` (strict): every name token present, at least
 *   two. Use before writing anything (accepting a quote, releasing a HOLD).
 * - `customerNameMatches` (same person): two names refer to one person,
 *   tolerant of given-name spelling ("Rachel"/"Rachael").
 * - `nameCorroborated`: fuzzy surname plus a first name (nickname-aware)
 *   or the street number. For "is this customer already booked?".
 * - `eventMatchesName` (loose): a surname hit alone. Read-only views that
 *   veto by address (customer timeline, triage).
 *
 * Consolidated 2026-11-05 from scheduling/name-match, scheduling/field-photos,
 * middleware job-customer-match + followup, and tools/stale-quotes.
 */

// ── name tokens ──────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'llc', 'inc', 'job', 'assessment', 'estimate', 'quote', 'repair',
  'crack', 'attack', 'foundation', 'basement', 'callback', 'call', 'with', 'for',
  'cont', // multi-day continuation marker in calendar titles ("Ed Spooner [cont]")
]);

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Surname-level equality tolerant of one-letter drift — calendar titles are
 * typed by ear and diverge from QBO ("Malderelli" vs "Maldarelli").
 */
export function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff <= 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (skipped++ > 0) {
      return false;
    } else {
      j++;
    }
  }
  return true;
}

/**
 * True when event text plausibly refers to a customer with these name
 * tokens. The last token is usually the surname, and a surname hit alone
 * counts; otherwise two token hits are needed.
 */
export function eventMatchesName(ev: { summary: string; location?: string }, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const hayTokens = nameTokens(`${ev.summary} ${ev.location ?? ''}`);
  const hits = tokens.filter((t) => hayTokens.some((h) => tokensAlike(h, t))).length;
  const last = tokens[tokens.length - 1];
  return hayTokens.some((h) => tokensAlike(h, last)) || hits >= 2;
}


// ── strict: every token present ──────────────────────────────────────

/** Lowercased, punctuation-stripped tokens of length ≥ 2. */
export function nameTokensForMatch(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * True when the customer's name (≥ 2 usable tokens, all present) appears
 * in the event summary. Summaries carry extra words ("Jane Smith — crack
 * injection", "STUB — Jane Smith"), so this asks presence, not equality.
 * Single-token names always return false: a bare surname ("Smith") can
 * never claim another customer's event.
 */
export function summaryMatchesCustomer(
  summary: string | undefined,
  customerName: string,
): boolean {
  if (!summary) return false;
  const tokens = nameTokensForMatch(customerName);
  if (tokens.length < 2) return false;
  const s = summary.toLowerCase();
  return tokens.every((t) => s.includes(t));
}

// ── same person ──────────────────────────────────────────────────────

function personTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/^(stub|hold)\s+—\s+/, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Two names are one person: same surname plus given names that share a
 * 4-char prefix ("rachel"/"rachael"); single-token names must be equal.
 */
export function customerNameMatches(eventSummary: string, customerName: string): boolean {
  const a = personTokens(eventSummary);
  const b = personTokens(customerName);
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length < 2 || b.length < 2) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false;
  const [givenA, givenB] = [a[0], b[0]];
  const prefix = Math.min(4, givenA.length, givenB.length);
  return givenA.slice(0, prefix) === givenB.slice(0, prefix);
}

// ── nicknames ────────────────────────────────────────────────────────

/** Calendar titles use what Matt calls the customer; PD/QBO have the
 *  formal name (or vice versa) — "Bob Doherty" vs "Robert Doherty"
 *  (reminder miss, 2026-10-19). Each group is a set of interchangeable
 *  first names; a name may sit in two groups ("ted"). */
const NICKNAME_GROUPS: string[][] = [
  ['robert', 'rob', 'bob', 'bobby'],
  ['william', 'will', 'bill', 'billy'],
  ['michael', 'mike'],
  ['james', 'jim', 'jimmy'],
  ['john', 'jack', 'johnny', 'jon', 'jonathan'],
  ['richard', 'rich', 'rick', 'dick'],
  ['thomas', 'tom', 'tommy'],
  ['christopher', 'chris'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave'],
  ['donald', 'don'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['theodore', 'ted', 'theo'],
  ['joseph', 'joe', 'joey'],
  ['anthony', 'tony'],
  ['stephen', 'steven', 'steve'],
  ['andrew', 'andy', 'drew'],
  ['matthew', 'matt'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron'],
  ['lawrence', 'larry'],
  ['gerald', 'jerry'],
  ['timothy', 'tim'],
  ['gregory', 'greg'],
  ['raymond', 'ray'],
  ['samuel', 'sam'],
  ['benjamin', 'ben'],
  ['nicholas', 'nick'],
  ['alexander', 'alex'],
  ['charles', 'charlie', 'chuck'],
  ['frederick', 'fred'],
  ['peter', 'pete'],
  ['philip', 'phil'],
  ['vincent', 'vince', 'vinny'],
  ['albert', 'al'],
  ['eugene', 'gene'],
  ['stanley', 'stan'],
  ['walter', 'walt'],
  ['jacob', 'jake'],
  ['joshua', 'josh'],
  ['zachary', 'zach'],
  ['nathaniel', 'nathan', 'nate'],
  ['patrick', 'pat'],
  ['patricia', 'pat', 'patty', 'tricia'],
  ['elizabeth', 'liz', 'beth', 'betsy'],
  ['katherine', 'catherine', 'kate', 'katie', 'kathy'],
  ['margaret', 'maggie', 'peggy', 'meg'],
  ['jennifer', 'jen', 'jenny'],
  ['susan', 'sue', 'suzie'],
  ['deborah', 'deb', 'debbie'],
  ['barbara', 'barb'],
  ['christine', 'christina', 'chris'],
  ['kimberly', 'kim'],
  ['cynthia', 'cindy'],
  ['sandra', 'sandy'],
  ['rebecca', 'becky'],
  ['victoria', 'vicky'],
  ['judith', 'judy'],
  ['dorothy', 'dot', 'dottie'],
  ['abigail', 'abby'],
  ['gabriel', 'gabe'],
  ['pamela', 'pam'],
];

const NICKNAME_MAP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of NICKNAME_GROUPS) {
    for (const name of group) {
      const set = map.get(name) ?? new Set<string>();
      for (const other of group) if (other !== name) set.add(other);
      map.set(name, set);
    }
  }
  return map;
})();

/** Same first name, or interchangeable nicknames ("bob" ≡ "robert"). Lowercase input. */
export function firstNamesAlike(a: string, b: string): boolean {
  return a === b || (NICKNAME_MAP.get(a)?.has(b) ?? false);
}

/** "Bob Doherty" → ["Robert Doherty", "Rob Doherty", "Bobby Doherty"].
 *  Only the first token varies. Returns [] when the first name has no
 *  known variants or the name is a single word. */
export function expandNicknames(name: string): string[] {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return [];
  const variants = NICKNAME_MAP.get(words[0].toLowerCase());
  if (!variants) return [];
  const rest = words.slice(1).join(' ');
  return [...variants].map((v) => `${v[0].toUpperCase()}${v.slice(1)} ${rest}`);
}

// ── compound names ───────────────────────────────────────────────────

const COMPOUND_SEPARATOR = /\s*&\s*|\s*\/\s*|\s+and\s+/i;

/**
 * Expand a compound calendar title into the individual person names a
 * search would match: split on &/and//, take the shared last name from
 * the first multi-word part, attach it to single-word parts.
 *
 *   "Lisa & John Hendrickson" → ["Lisa Hendrickson", "John Hendrickson"]
 *   "Bob/Alice Smith"         → ["Bob Smith", "Alice Smith"]
 *   "John Smith"              → []  (no separator)
 *   "Bob & Alice"             → []  (no shared last name)
 */
export function expandCompoundName(summary: string): string[] {
  if (!summary || !COMPOUND_SEPARATOR.test(summary)) return [];

  const parts = summary.split(COMPOUND_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [];

  let sharedLastName: string | null = null;
  for (const part of parts) {
    const words = part.split(/\s+/);
    if (words.length >= 2) {
      sharedLastName = words[words.length - 1];
      break;
    }
  }
  if (!sharedLastName) return [];

  return parts.map((part) => (part.split(/\s+/).length >= 2 ? part : `${part} ${sharedLastName}`));
}

// ── corroborated: surname + first name or street number ──────────────

/**
 * True when `text` (an event's summary + location) names this customer:
 * the surname matches with one-letter drift ("Erikson" for "Eriksen") AND
 * a first name (nickname-aware) or the street number from `address` also
 * appears. Surname alone is never enough: it matched Melanie Doherty to
 * Bob Doherty's job on the stale-quotes dry run.
 */
export function nameCorroborated(text: string, customerName: string, address = ''): boolean {
  const tokens = customerName.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1];
  const first = tokens[0];
  const hay = text.toLowerCase();
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.some((w) => w.length >= 3 && tokensAlike(w, last))) return false;
  const firstHit = first !== last && words.some((w) => firstNamesAlike(first, w));
  const streetNum = (address.match(/\b(\d{1,5})\b/) ?? [])[1];
  const addrHit = !!streetNum && hay.includes(streetNum);
  return firstHit || addrHit;
}

// ── surname-weighted tokens ──────────────────────────────────────────

/**
 * Words of 4+ letters split into surname and given names. Callers weight
 * them differently: a surname hit can match on its own, a given-name hit
 * needs corroboration (an assessment visit, a nearby date).
 */
export function lastFirstTokens(customerName: string): { last: string[]; first: string[] } {
  const words = String(customerName ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4);
  if (words.length <= 1) return { last: words, first: [] };
  return { last: [words[words.length - 1]], first: words.slice(0, -1) };
}
