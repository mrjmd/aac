/**
 * Resolve the city of a calendar event by matching it to its Pipedrive
 * person and pulling the structured address PD already has (auto-populated
 * via Google Places when the address was entered in PD's UI).
 *
 * Falls back to the imperfect string parser only when no PD match exists
 * (internal events: BNI, meetings, etc.) or when PD's address record is
 * blank.
 *
 * Cached in Redis under keys.fieldEventCustomer for 24h so repeat loads
 * of the day's list don't re-do PD matching per event.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { keys, ttl } from '@aac/shared-utils/redis';
import { getPipedrive, getRedis } from './clients';
import { matchEventToPerson } from './customer-match';
import { extractCity } from './location';

/**
 * AAC's "Address" custom field in Pipedrive. PD stores Google-Places-
 * structured sub-fields under `<fieldId>_locality` (city),
 * `_admin_area_level_1` (state), `_postal_code`, etc.
 */
const PD_ADDRESS_FIELD = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';

interface CachedResolution {
  pdPersonId: number | null;
  city: string | null;
}

function pickCityFromPdPerson(person: unknown): string | null {
  const p = person as Record<string, unknown> | null;
  if (!p) return null;
  const city = p[`${PD_ADDRESS_FIELD}_locality`];
  return typeof city === 'string' && city.length > 0 ? city : null;
}

/**
 * Returns the best-effort city name for an event, or null if no signal at all.
 * Cached per calendar event ID; safe to call N times per page load.
 */
export async function resolveEventCity(event: CalendarEvent): Promise<string | null> {
  const redis = getRedis();
  const cacheKey = keys.fieldEventCustomer(event.id);

  const cached = await redis.get<CachedResolution>(cacheKey);
  if (cached) return cached.city;

  let resolved: CachedResolution = { pdPersonId: null, city: null };

  // 1) Try Pipedrive (structured data, source of truth for customer addresses)
  try {
    const person = await matchEventToPerson(event, getPipedrive());
    if (person) {
      const pdCity = pickCityFromPdPerson(person);
      resolved = { pdPersonId: person.id, city: pdCity };
    }
  } catch {
    // Fall through to parser fallback
  }

  // 2) Fallback to free-text parser (internal events, missing PD address)
  if (!resolved.city) {
    resolved.city = extractCity(event.location);
  }

  await redis.set(cacheKey, resolved, { ex: ttl.fieldEventCustomer });
  return resolved.city;
}
