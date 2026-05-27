/**
 * Helpers for displaying / linking to event locations.
 */

/**
 * Pull just the city out of a Google-style address like
 *   "North Main Street, N Main St, Quincy, MA 02368, USA"
 * → "Quincy"
 *
 * Strategy: split on commas, drop the country ("USA"), drop the state+zip
 * piece (has digits or is just a two-letter state code), and take what's
 * left as the last segment. Falls back to the raw location if nothing fits
 * (e.g. a single-line address with no commas).
 */
export function extractCity(location: string | undefined | null): string | null {
  if (!location) return null;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  const filtered = parts.filter((p) => {
    const upper = p.toUpperCase();
    if (upper === 'USA' || upper === 'US' || upper === 'UNITED STATES') return false;
    // "MA 02368" or "MA" alone — state with optional zip
    if (/^[A-Z]{2}(\s+\d{4,5}(-\d{4})?)?$/.test(p)) return false;
    // Anything with a leading digit is a street ("123 Main St")
    if (/^\d/.test(p)) return false;
    return true;
  });

  if (filtered.length === 0) return parts[parts.length - 1] ?? null;
  return filtered[filtered.length - 1];
}

/** Google Maps deep link: opens the native app on mobile, web on desktop. */
export function buildDirectionsUrl(destination: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
