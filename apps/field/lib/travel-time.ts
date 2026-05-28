/**
 * Drive-time estimates for the tech's daily schedule.
 *
 * For the first event of the day, origin = Mike's home. For subsequent
 * events, origin = the previous event's location. Distance Matrix is called
 * once per leg (traffic-aware via `departure_time` = event start).
 *
 * Cached in Redis keyed by (origin, destination, day-of-week, hour) for
 * 30 days. Traffic patterns at the same hour of the same weekday are
 * stable enough that a 30-day cache is plenty; first-time loads of a
 * common origin/destination pair are slow, repeats are instant + free.
 */

import { createHash } from 'node:crypto';

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { TravelEstimate } from '@aac/api-clients/google-maps';
import { keys, ttl } from '@aac/shared-utils/redis';
import { getMaps, getRedis } from './clients';

/**
 * Mike's home address — origin for the first leg of every day.
 * Single-tech assumption: when a second tech is added, this becomes a
 * per-tech lookup keyed by tech email.
 */
export const MIKE_HOME_ADDRESS = '30 Randlett Street, Quincy, MA 02170';

export interface TravelLeg {
  /** Calendar event ID this leg ends at. */
  eventId: string;
  /** Drive duration in seconds. */
  durationSec: number;
  /** Drive distance in meters. */
  distanceMeters: number;
  /** True for the first leg of the day (origin = home). */
  fromHome: boolean;
}

function bucketKey(origin: string, destination: string, departure: Date): string {
  const dow = departure.getUTCDay(); // 0=Sun..6=Sat in UTC; fine for a stable cache bucket
  const hour = departure.getUTCHours();
  const hash = createHash('sha1').update(`${origin}|${destination}|${dow}|${hour}`).digest('hex').slice(0, 16);
  return hash;
}

/**
 * Compute drive-time legs for a sorted list of same-day events. Returns a
 * Map keyed by event ID — the leg's `from` is "home" (for first event) or
 * the previous event's location. Events with no `location` are skipped
 * (no leg in the map).
 */
export async function resolveTravelLegs(
  events: CalendarEvent[],
): Promise<Map<string, TravelLeg>> {
  const out = new Map<string, TravelLeg>();
  if (events.length === 0) return out;

  // Build the leg list: for each event with a location, derive its origin.
  type LegSpec = { eventId: string; origin: string; destination: string; departure: Date; fromHome: boolean };
  const legs: LegSpec[] = [];
  let lastLocation: string | null = null;
  for (const evt of events) {
    if (!evt.location) {
      // Skip events with no address. Don't reset lastLocation — the next
      // event still drives from wherever Mike actually was last.
      continue;
    }
    const origin = lastLocation ?? MIKE_HOME_ADDRESS;
    legs.push({
      eventId: evt.id,
      origin,
      destination: evt.location,
      departure: new Date(evt.start),
      fromHome: lastLocation === null,
    });
    lastLocation = evt.location;
  }

  if (legs.length === 0) return out;

  // Phase 1: check cache for every leg in one mget.
  const redis = getRedis();
  const cacheKeys = legs.map((l) => keys.fieldTravelLeg(bucketKey(l.origin, l.destination, l.departure)));
  const cached = await redis.mget<(TravelEstimate | null)[]>(...cacheKeys);

  // Phase 2: dispatch Distance Matrix in parallel for any cache misses.
  const maps = getMaps();
  const fetches = legs.map(async (leg, i) => {
    if (cached[i]) return cached[i];
    const fresh = await maps.getTravelTime(leg.origin, leg.destination, { departureTime: leg.departure });
    if (fresh) {
      await redis.set(cacheKeys[i], fresh, { ex: ttl.fieldTravelLeg });
    }
    return fresh;
  });
  const resolved = await Promise.all(fetches);

  legs.forEach((leg, i) => {
    const est = resolved[i];
    if (est) {
      out.set(leg.eventId, {
        eventId: leg.eventId,
        durationSec: est.durationSec,
        distanceMeters: est.distanceMeters,
        fromHome: leg.fromHome,
      });
    }
  });

  return out;
}

/** "23 min" or "1h 5min" — short, mobile-friendly. */
export function formatDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

/** "12.3 mi" — imperial, one decimal under 100mi, no decimal above. */
export function formatDistance(meters: number): string {
  const miles = meters / 1609.344;
  return miles < 100 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}
