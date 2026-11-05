/**
 * Pure: tie a website tap that carried a gclid to the phone number that
 * then called or texted the business line.
 *
 * Two ways to match, best first:
 *  1. Ref code. MA text buttons prefill "(Ref: K7QM)" and log the same code
 *     on the GA4 tap (aac-astro Layout.astro). Exact, works for any number.
 *  2. Timing. A brand-new number's first inbound call/text lands within
 *     -2/+3 minutes of the tap (GA4 logs to the minute, so the window is
 *     widened by one minute on the late side). Two different new numbers in
 *     the window, or one number claimed by taps with different gclids, is
 *     ambiguous and skipped: Google needs a clean signal, not every lead.
 */

export type TapKind = 'call' | 'text';

export interface AdTap {
  /** Start of the GA4 minute the tap was logged in. */
  at: Date;
  gclid: string;
  kind: TapKind;
  refCode: string | null;
}

export interface InboundEvent {
  /** 10-digit phone. */
  phone: string;
  at: Date;
  kind: TapKind;
  /** Message body (texts only). */
  text?: string;
  /** True when this is the number's first-ever contact with the line. */
  firstContact: boolean;
}

export interface AdClick {
  phone: string;
  gclid: string;
  /** ISO tap time. */
  tapAt: string;
  matchedBy: 'ref' | 'timing';
  /** ISO time of the inbound event the tap matched. */
  contactAt: string;
}

export interface MatchResult {
  matches: AdClick[];
  ambiguous: number;
  unmatched: number;
}

const MIN = 60_000;
export const WINDOW_BEFORE_MS = 2 * MIN;
// +3 minutes after the tap, plus the minute GA4 truncates away.
export const WINDOW_AFTER_MS = 4 * MIN;
/** How long after a tap a ref-coded text still counts. */
export const REF_MAX_DELAY_MS = 7 * 24 * 60 * MIN;

// Same alphabet as the website's newRefCode(): no 0/O, 1/I/L.
const REF_RE = /\bRef:?\s*([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4})\b/i;

/** The ref code in a message body, upper-cased, or null. */
export function parseRefCode(text: string | null | undefined): string | null {
  const m = REF_RE.exec(text ?? '');
  return m ? m[1].toUpperCase() : null;
}

export function matchTaps(taps: AdTap[], events: InboundEvent[]): MatchResult {
  const matches = new Map<string, AdClick>(); // phone → click
  const usedTaps = new Set<AdTap>();
  let ambiguous = 0;

  // 1. Ref codes: exact, any number.
  const tapsByRef = new Map<string, AdTap[]>();
  for (const t of taps) {
    if (!t.refCode) continue;
    const list = tapsByRef.get(t.refCode) ?? [];
    list.push(t);
    tapsByRef.set(t.refCode, list);
  }
  const byTime = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const ev of byTime) {
    if (ev.kind !== 'text' || matches.has(ev.phone)) continue;
    const code = parseRefCode(ev.text);
    if (!code) continue;
    const candidates = (tapsByRef.get(code) ?? []).filter((t) => {
      const lag = ev.at.getTime() - t.at.getTime();
      return lag >= -WINDOW_BEFORE_MS && lag <= REF_MAX_DELAY_MS;
    });
    // The same tap logged twice (double tap) is one candidate.
    const gclids = new Set(candidates.map((t) => t.gclid));
    if (gclids.size !== 1) {
      if (gclids.size > 1) ambiguous++;
      continue;
    }
    const tap = candidates[0];
    candidates.forEach((t) => usedTaps.add(t));
    matches.set(ev.phone, {
      phone: ev.phone,
      gclid: tap.gclid,
      tapAt: tap.at.toISOString(),
      matchedBy: 'ref',
      contactAt: ev.at.toISOString(),
    });
  }

  // 2. Timing: remaining taps against first contacts from new numbers.
  const firsts = byTime.filter((e) => e.firstContact && !matches.has(e.phone));
  const claims = new Map<string, Array<{ tap: AdTap; ev: InboundEvent }>>(); // phone → taps
  let unmatched = 0;
  for (const tap of taps) {
    if (usedTaps.has(tap)) continue;
    const inWindow = firsts.filter((e) => {
      const lag = e.at.getTime() - tap.at.getTime();
      return lag >= -WINDOW_BEFORE_MS && lag <= WINDOW_AFTER_MS;
    });
    const phones = new Set(inWindow.map((e) => e.phone));
    if (phones.size === 0) {
      unmatched++;
      continue;
    }
    if (phones.size > 1) {
      ambiguous++;
      continue;
    }
    const ev = inWindow[0];
    const list = claims.get(ev.phone) ?? [];
    list.push({ tap, ev });
    claims.set(ev.phone, list);
  }
  for (const [phone, list] of claims) {
    if (new Set(list.map((c) => c.tap.gclid)).size > 1) {
      ambiguous++;
      continue;
    }
    const first = list.reduce((a, b) => (b.tap.at < a.tap.at ? b : a));
    matches.set(phone, {
      phone,
      gclid: first.tap.gclid,
      tapAt: first.tap.at.toISOString(),
      matchedBy: 'timing',
      contactAt: first.ev.at.toISOString(),
    });
  }

  return { matches: [...matches.values()], ambiguous, unmatched };
}
