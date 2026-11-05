/**
 * Street-address identity — the one parser for "is this the same house?".
 * Like phone normalization, every package that joins on an address uses
 * this (customers, scheduling, multi-day chains, triage). Moved here from
 * @aac/customers/match.ts on 2026-11-05 so shared-utils callers can use it.
 */

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

/** Same house + street (two streetKeys); units must agree only when both sides have one. */
export function sameStreet(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [an, as, au] = a.split('|');
  const [bn, bs, bu] = b.split('|');
  return an === bn && as === bs && (!au || !bu || au === bu);
}

/** Two free-form addresses name the same house ("122 Allen Avenue, Falmouth" ≡ "122 Allen Ave"). */
export function addressesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return sameStreet(streetKey(a), streetKey(b));
}
