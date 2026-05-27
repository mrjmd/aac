/**
 * Helpers for displaying / linking to event locations.
 */

const COUNTRIES = new Set([
  'usa', 'us', 'united states', 'united states of america', 'canada',
]);

/** US states + DC, full names and 2-letter postal codes, all lowercase. */
const STATES = new Set([
  'alabama','al','alaska','ak','arizona','az','arkansas','ar',
  'california','ca','colorado','co','connecticut','ct','delaware','de',
  'florida','fl','georgia','ga','hawaii','hi','idaho','id',
  'illinois','il','indiana','in','iowa','ia','kansas','ks',
  'kentucky','ky','louisiana','la','maine','me','maryland','md',
  'massachusetts','ma','michigan','mi','minnesota','mn','mississippi','ms',
  'missouri','mo','montana','mt','nebraska','ne','nevada','nv',
  'new hampshire','nh','new jersey','nj','new mexico','nm','new york','ny',
  'north carolina','nc','north dakota','nd','ohio','oh','oklahoma','ok',
  'oregon','or','pennsylvania','pa','rhode island','ri',
  'south carolina','sc','south dakota','sd','tennessee','tn','texas','tx',
  'utah','ut','vermont','vt','virginia','va','washington','wa',
  'west virginia','wv','wisconsin','wi','wyoming','wy',
  'district of columbia','dc',
]);

/** "Massachusetts 02043" or "MA 02043" or "Massachusetts" → state-like */
function isStateLike(part: string): boolean {
  const normalized = part.toLowerCase().replace(/\s+\d{4,5}(-\d{4})?$/, '').trim();
  return STATES.has(normalized);
}

/**
 * Pull just the city out of a Google-style address like
 *   "123 Main St, Hingham, Massachusetts 02043, United States"
 * → "Hingham"
 *
 * Strategy: split on commas, then pop the country (if it matches a known one),
 * pop the state-like piece (full name or 2-letter, with or without zip), and
 * walk back over any street-style entries (start with a digit). Whatever
 * remains is the city. Returns null when nothing recognizable is left
 * (e.g. address is just "Massachusetts 02135" with no city named).
 */
export function extractCity(location: string | undefined | null): string | null {
  if (!location) return null;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return /\d/.test(parts[0]) ? null : parts[0];

  let i = parts.length - 1;
  if (COUNTRIES.has(parts[i].toLowerCase())) i--;
  if (i >= 0 && isStateLike(parts[i])) i--;
  while (i >= 0 && /^\d/.test(parts[i])) i--;
  if (i < 0) return null;
  // Final sanity: the candidate itself shouldn't be a state name we missed.
  if (isStateLike(parts[i])) return null;
  return parts[i];
}

/** Google Maps deep link: opens the native app on mobile, web on desktop. */
export function buildDirectionsUrl(destination: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
