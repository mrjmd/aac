/**
 * Post-login return-to sanitizer (open-redirect guard) for the command
 * center and field app sign-in flows.
 *
 * Parses `next` with the WHATWG URL parser against the app's origin and
 * keeps only pathname + search when the result is same-origin. Prefix
 * checks like `startsWith('/') && !startsWith('//')` miss `/\evil.com`,
 * `/\t/evil.com` and friends, which browsers resolve to another host.
 */

/** Stand-in origin when the caller has none (e.g. a server component). */
const FALLBACK_ORIGIN = 'https://return-path.invalid';

/**
 * Returns a same-origin path (`/path?query`) or `/`.
 *
 * @param next   untrusted return-to value (query param, stored state)
 * @param origin the app's own origin; defaults to a placeholder, which
 *               accepts relative paths only
 */
export function safeReturnPath(next: string | null | undefined, origin: string = FALLBACK_ORIGIN): string {
  if (!next) return '/';
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(next, base);
  } catch {
    return '/';
  }
  if (url.origin !== base.origin) return '/';
  const path = url.pathname + url.search;
  // Dot-segment normalization can yield "//host" (e.g. "/x/..//evil.com"),
  // which a later new URL(path, origin) would treat as protocol-relative.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}
