/**
 * Customer name and address matching, shared by the triage detectors
 * (tools/src/triage), the command center Customer page and scheduling.
 * Moved here from tools/src/triage/identity.ts on 2026-11-03.
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

// ── address identity ─────────────────────────────────────────────────

const STREET_WORDS = new Set([
  'street', 'st', 'avenue', 'ave', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'court', 'ct',
  'place', 'pl', 'circle', 'cir', 'terrace', 'way', 'wy', 'boulevard', 'blvd', 'parkway',
  'pkwy', 'highway', 'hwy', 'square', 'sq', 'path', 'row',
]);
const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'n', 's', 'e', 'w']);

/**
 * `{houseNumber}|{first street-name token}|{unit}` — e.g. "138 Elm Street,
 * Unit Number 35, Kingston" and "138 Elm St. unit 35" both → "138|elm|35".
 * Needs a house number followed by a street name; with `requireSuffix`
 * (free text like email subjects) the street must also carry a suffix word
 * so "Quote 1580 from Attack A Crack" never parses as an address.
 */
export function streetKey(text: string, requireSuffix = false): string | null {
  const m = /(?:^|[\s,(])(\d{1,6})[a-z]?\s+([a-z][a-z.' -]*)/i.exec(text);
  if (!m) return null;
  const words = m[2]
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const name = words.find((w) => !DIRECTIONS.has(w) && !STREET_WORDS.has(w) && w.length >= 3);
  if (!name) return null;
  if (requireSuffix && !words.some((w) => STREET_WORDS.has(w))) return null;
  const unit = /\b(?:unit|apt|apartment|suite|ste)\s*(?:number|num|no\.?|#)?\s*#?\s*([a-z]?\d+[a-z]?)\b|#\s*(\d+[a-z]?)\b/i.exec(text);
  return `${m[1]}|${name}|${(unit?.[1] ?? unit?.[2] ?? '').toLowerCase()}`;
}

// ── inputs ───────────────────────────────────────────────────────────
