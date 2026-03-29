/**
 * Canonical phone normalization — THE single source of truth.
 *
 * Extracted from aac-slim/src/lib/phone.ts. Consolidates the 4 duplicate
 * implementations that existed across the old codebase.
 *
 * TODO: Copy the canonical implementation from aac-slim during Phase 0 extraction.
 */

export interface NormalizeResult {
  e164: string;
  national: string;
  country: string;
}

/**
 * Normalize any phone format to E.164 (+15551234567).
 * Returns null if the input is not a valid phone number.
 */
export function normalizePhone(phone: string, _country = 'US'): string | null {
  // TODO: Extract from aac-slim/src/lib/phone.ts
  throw new Error('Not yet extracted — run Phase 0 extraction');
}

/**
 * Parse a phone number into detailed components.
 */
export function parsePhone(phone: string, _country = 'US'): NormalizeResult | null {
  // TODO: Extract from aac-slim/src/lib/phone.ts
  throw new Error('Not yet extracted — run Phase 0 extraction');
}

/**
 * Compare two phone numbers for equality regardless of format.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  // TODO: Extract from aac-slim/src/lib/phone.ts
  throw new Error('Not yet extracted — run Phase 0 extraction');
}

/**
 * Convert to 10-digit format for Redis storage (no +1 prefix).
 */
export function toRedisPhone(phone: string): string | null {
  // TODO: Extract from aac-slim/src/lib/phone.ts
  throw new Error('Not yet extracted — run Phase 0 extraction');
}
