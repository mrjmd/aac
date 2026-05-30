/**
 * Drive-time primitive — single (origin → destination, departure-time) lookup
 * with optional Redis caching. Used by:
 *   - apps/field for per-event drive-time chips on the tech's daily schedule
 *   - suggestSlot (here) for travel-aware slot feasibility checks
 *
 * Cache key is bucketed by (origin, destination, day-of-week, hour) so that
 * traffic patterns at the same hour-of-week share a cached estimate. Patterns
 * at the same hour of the same weekday are stable enough that a 30-day cache
 * (TTL = `ttl.fieldTravelLeg`) is safe.
 */

import { createHash } from 'node:crypto';
import type { GoogleMapsClient } from '@aac/api-clients/google-maps';
import { keys, ttl } from '@aac/shared-utils/redis';

/**
 * Default home address used as the bookend anchor when the technician hasn't
 * configured their own via /settings. Originally Mike's address; overridden
 * per-user in apps/field once they save their own.
 */
export const DEFAULT_HOME_ADDRESS = '30 Randlett Street, Quincy, MA 02170';

export interface TravelLeg {
  /** Drive duration in seconds. Includes traffic when departureTime is set. */
  durationSec: number;
  /** Drive distance in meters. */
  distanceMeters: number;
}

/**
 * Stable cache key for a single (origin, destination, departure-bucket) triple.
 * Hashed to keep Upstash key length manageable while preserving uniqueness.
 */
export function travelLegBucketKey(
  origin: string,
  destination: string,
  departure: Date,
): string {
  const dow = departure.getUTCDay();
  const hour = departure.getUTCHours();
  return createHash('sha1')
    .update(`${origin}|${destination}|${dow}|${hour}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Minimal Redis surface this primitive needs — caller passes an Upstash-style
 * client (apps/field already constructs one; we don't construct here so the
 * scheduling package stays I/O-free at module load).
 */
export interface TravelLegCache {
  get(key: string): Promise<TravelLeg | null>;
  set(key: string, value: TravelLeg, ttlSec: number): Promise<unknown>;
}

export interface GetTravelLegDeps {
  maps: GoogleMapsClient;
  cache?: TravelLegCache;
}

/**
 * Resolve a single drive leg. Returns the cached estimate when warm,
 * otherwise hits Distance Matrix and warms the cache. Returns null when
 * Maps can't compute a route (unreachable, typo, API failure) — callers
 * should treat null as "unknown, fail closed".
 */
export async function getTravelLeg(
  origin: string,
  destination: string,
  departure: Date,
  deps: GetTravelLegDeps,
): Promise<TravelLeg | null> {
  const bucket = travelLegBucketKey(origin, destination, departure);
  const cacheKey = keys.fieldTravelLeg(bucket);

  if (deps.cache) {
    const cached = await deps.cache.get(cacheKey);
    if (cached) return cached;
  }

  const fresh = await deps.maps.getTravelTime(origin, destination, {
    departureTime: departure,
  });
  if (!fresh) return null;

  const leg: TravelLeg = {
    durationSec: fresh.durationSec,
    distanceMeters: fresh.distanceMeters,
  };

  if (deps.cache) {
    await deps.cache.set(cacheKey, leg, ttl.fieldTravelLeg);
  }

  return leg;
}
