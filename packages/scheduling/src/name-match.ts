/**
 * Strict customer-name presence check for calendar-event summaries.
 *
 * Event summaries carry extra words ("Jane Smith — crack injection rear
 * wall", "STUB — Jane Smith"), so equality-style matchers
 * (`customerNameMatches` in field-photos.ts) don't apply. This check asks
 * only "does this customer's name appear in the summary?" — but strictly:
 * at least two name tokens, and every token must be present, so a bare
 * surname ("Smith") can never claim another customer's event.
 */

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
 * in the event summary. Single-token names always return false — too loose
 * to disambiguate; callers should treat that as "cannot match safely".
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
