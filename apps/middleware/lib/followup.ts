/**
 * Post-job follow-up SMS helpers.
 *
 * Three pieces of variable content combine into the rendered template:
 *   {when}    — natural-language reference to when the job happened
 *               ("yesterday", "on Monday", "last week", "a couple weeks ago")
 *   {prompt}  — variant-specific review prompt sentence
 *
 * Three review prompt variants rotate per event (hash of event ID):
 *   - mike:    asks the customer to mention Mike by name
 *   - city:    asks the customer to mention their city (helps local SEO)
 *   - service: asks the customer to mention the specific service performed
 *
 * Variant selection degrades gracefully: if city extraction fails, fall back
 * to mike. If service classification returns null, fall back to city, then mike.
 * The variant sent for each event is recorded in Redis for later attribution.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { GeminiClient } from '@aac/api-clients/gemini';
import { getRedis } from './redis.js';

const log = createLogger('followup');

// ── Canonical service list ───────────────────────────────────────────
// Derived from aac-astro project taxonomy and service pages. Edit here.
// Names are lowercase and chosen for natural inclusion in a review sentence:
// "If you could mention the {service} in your review..."
export const CANONICAL_SERVICES = [
  'crack injection',
  'bulkhead repair',
  'fieldstone re-pointing',
  'carbon fiber stitches',
  'concrete repair',
  'concrete resurfacing',
  'garage floor repair',
  'concrete stairway repair',
  'walkway repair',
  'patio resurfacing',
  'pool deck resurfacing',
  'driveway repair',
  'sewer line repair',
] as const;

export type CanonicalService = (typeof CANONICAL_SERVICES)[number];

// ── Variant types ────────────────────────────────────────────────────

export type FollowUpVariant = 'mike' | 'city' | 'service';

export interface VariantSelection {
  variant: FollowUpVariant;
  prompt: string;
}

// ── formatWhen ───────────────────────────────────────────────────────

/**
 * Format the natural-language time reference for the job date.
 *
 * Examples (with now=2026-05-13, a Wednesday):
 *   jobDate=2026-05-12 → "yesterday"
 *   jobDate=2026-05-11 → "on Sunday"
 *   jobDate=2026-05-07 → "last week"
 *   jobDate=2026-04-29 → "a couple weeks ago"
 *   jobDate=2026-04-15 → "a few weeks ago"
 */
export function formatWhen(jobDateIso: string, now: Date = new Date()): string {
  const job = new Date(jobDateIso.split('T')[0] + 'T12:00:00-04:00');
  const ref = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ref.setHours(12, 0, 0, 0);
  job.setHours(12, 0, 0, 0);

  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((ref.getTime() - job.getTime()) / msPerDay);

  if (days <= 1) return 'yesterday';
  if (days <= 6) {
    const dayName = job.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    return `on ${dayName}`;
  }
  if (days <= 13) return 'last week';
  if (days <= 20) return 'a couple weeks ago';
  return 'a few weeks ago';
}

// ── extractCity ──────────────────────────────────────────────────────

const STATE_CODES = new Set([
  'MA', 'CT', 'NH', 'RI', 'VT', 'ME', 'NY', 'NJ', 'PA',
]);

const STATE_NAMES = new Set([
  'massachusetts', 'connecticut', 'new hampshire', 'rhode island',
  'vermont', 'maine', 'new york', 'new jersey', 'pennsylvania',
]);

function isStateOnly(segment: string): boolean {
  const trimmed = segment.trim();
  if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(trimmed) && STATE_CODES.has(trimmed.slice(0, 2))) {
    return true;
  }
  return STATE_NAMES.has(trimmed.toLowerCase());
}

/**
 * Extract the city from a Google Calendar location string.
 *
 * Handles formats like:
 *   "36 Frank Rd, Weymouth, MA 02191, USA"        → "Weymouth"
 *   "16 Kirkland Road, Cambridge MA"               → "Cambridge"
 *   "76A Brook Street Scituate MA"                 → "Scituate"
 *   "367 New Meadow Road, Barrington, Rhode Island, 02806" → "Barrington"
 *
 * Limitation: two-word cities without commas (e.g. "New Bedford MA") return
 * only the last word ("Bedford"). Acceptable v1; revisit if it matters.
 */
export function extractCity(location: string | undefined | null): string | null {
  if (!location) return null;
  const trimmed = location.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    if (isStateOnly(parts[i])) {
      return parts[i - 1];
    }
  }

  const trailingMatch = trimmed.match(/([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+([A-Z]{2})\s*$/);
  if (trailingMatch && STATE_CODES.has(trailingMatch[2])) {
    const words = trailingMatch[1].split(/\s+/);
    return words[words.length - 1];
  }

  return null;
}

// ── classifyService ──────────────────────────────────────────────────

const SERVICE_PROMPT = `You classify a foundation repair job into a canonical service category based on a free-text description written by the company owner.

Canonical services (pick exactly ONE, or respond with "none"):
${CANONICAL_SERVICES.map((s) => `- ${s}`).join('\n')}
- none

Rules:
- The description is the owner's planning shorthand, not customer-facing language. Map shorthand to the canonical category: "crack" / "injection" → crack injection; "spalling" / "resurface" → concrete resurfacing; "re-pointing" / "field stone" → fieldstone re-pointing; "stairway" → concrete stairway repair; "bulkhead" → bulkhead repair.
- If the description clearly indicates one primary service, return that canonical name.
- If multiple distinct services are mentioned, return the one that is described first or in more detail. When in doubt, return "none".
- If the description is too vague, unrelated, or you cannot confidently classify, return "none".
- Respond with ONLY the canonical name (lowercase) or "none". No quotes, no JSON, no explanation, no punctuation.

Description:
{description}

Service:`;

/**
 * Classify a job description into a canonical service.
 * Returns null if the description cannot be confidently classified.
 */
export async function classifyService(
  description: string | undefined | null,
  gemini: GeminiClient
): Promise<CanonicalService | null> {
  if (!description || description.trim().length < 5) return null;

  const prompt = SERVICE_PROMPT.replace('{description}', description.trim());

  try {
    const raw = await gemini.generateContent(prompt, {
      temperature: 0.1,
      maxOutputTokens: 32,
    });
    const cleaned = raw.trim().toLowerCase().replace(/['"`.]/g, '');

    if (cleaned === 'none' || !cleaned) return null;
    if ((CANONICAL_SERVICES as readonly string[]).includes(cleaned)) {
      return cleaned as CanonicalService;
    }
    log.warn('Gemini returned non-canonical service', { raw, cleaned });
    return null;
  } catch (error) {
    log.error('Service classification failed', error as Error);
    return null;
  }
}

// ── selectVariant ────────────────────────────────────────────────────

const MIKE_PROMPT =
  "And if you want to give Mike a shout-out by name, he'd really appreciate it.";

function cityPromptFor(city: string): string {
  return `If you could mention being in ${city} in your review, it really helps other folks in the area find us.`;
}

function servicePromptFor(service: string): string {
  return `If you could mention the ${service} in your review, it really helps other people who need the same thing find us.`;
}

/**
 * Stable hash of event ID to one of 3 buckets (0=mike, 1=city, 2=service).
 * Same event always gets the same slot — important if we ever re-run.
 */
function variantSlot(eventId: string): 0 | 1 | 2 {
  let hash = 0;
  for (let i = 0; i < eventId.length; i++) {
    hash = (hash * 31 + eventId.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 3) as 0 | 1 | 2;
}

/**
 * Pick a variant for this event, with graceful fallback.
 *
 * The selected slot is the *target*. If the target's data isn't available
 * (no city, or service classification returned null), fall through to the
 * next variant. Mike variant always works.
 */
export function selectVariant(
  eventId: string,
  city: string | null,
  service: CanonicalService | null
): VariantSelection {
  const slot = variantSlot(eventId);

  // Try slots in order starting from target, falling through.
  const tryOrder = [slot, (slot + 1) % 3, (slot + 2) % 3];
  for (const s of tryOrder) {
    if (s === 0) return { variant: 'mike', prompt: MIKE_PROMPT };
    if (s === 1 && city) return { variant: 'city', prompt: cityPromptFor(city) };
    if (s === 2 && service) return { variant: 'service', prompt: servicePromptFor(service) };
  }

  // Unreachable: mike is always available, but TS doesn't know that.
  return { variant: 'mike', prompt: MIKE_PROMPT };
}

// ── recordVariant ────────────────────────────────────────────────────

const VARIANT_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Record which variant was sent for an event. Used for retroactive
 * attribution once GBP review ingestion is in place.
 */
export async function recordVariant(eventId: string, variant: FollowUpVariant): Promise<void> {
  const redis = getRedis();
  await redis.set(`followup:variant:${eventId}`, variant, { ex: VARIANT_TTL_SECONDS });
}
