/**
 * Drive-time estimates for the tech's daily schedule.
 *
 * Per-event UI orchestration: walks the day's sorted events and produces a
 * leg arriving at each event with a location (origin = previous event's
 * location, or home for the first), plus a final "back home" leg.
 *
 * The single (origin → destination, departure) lookup primitive — including
 * the Redis cache + Distance-Matrix call — lives in `@aac/scheduling/travel-time`
 * so suggestSlot can share it. This file only owns the per-day fan-out.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import {
  DEFAULT_HOME_ADDRESS,
  getTravelLeg,
  travelLegBucketKey,
  type TravelLeg,
} from '@aac/scheduling';
import { keys, ttl } from '@aac/shared-utils/redis';
import { getMaps, getRedis } from './clients';

export { DEFAULT_HOME_ADDRESS };

export interface DayTravelLeg extends TravelLeg {
  /** True for the first leg of the day (origin = home). */
  fromHome: boolean;
}

export interface DayTravel {
  /** Leg ending at each event with a location, keyed by event ID. */
  byEvent: Map<string, DayTravelLeg>;
  /** Final leg: from the last event back to home. Null if no events had locations. */
  backHome: DayTravelLeg | null;
}

export interface ResolveTravelLegsOptions {
  /**
   * Origin for the first leg of the day and destination for the back-home
   * leg. Defaults to {@link DEFAULT_HOME_ADDRESS} when omitted/null.
   * When neither is available (caller explicitly passes `null` and the
   * default is dropped in the future), the bookend legs are omitted.
   */
  homeAddress?: string | null;
}

export async function resolveTravelLegs(
  events: CalendarEvent[],
  options: ResolveTravelLegsOptions = {},
): Promise<DayTravel> {
  const out: DayTravel = { byEvent: new Map(), backHome: null };
  if (events.length === 0) return out;

  const homeAddress = options.homeAddress ?? DEFAULT_HOME_ADDRESS;

  type LegSpec = {
    /** Set for arrival legs; null for the back-home leg. */
    eventId: string | null;
    origin: string;
    destination: string;
    departure: Date;
    fromHome: boolean;
  };
  const legs: LegSpec[] = [];
  let lastLocation: string | null = null;
  let lastEventEnd: string | null = null;
  for (const evt of events) {
    if (!evt.location) continue;
    if (lastLocation === null && !homeAddress) {
      lastLocation = evt.location;
      lastEventEnd = evt.end;
      continue;
    }
    const origin = lastLocation ?? homeAddress;
    legs.push({
      eventId: evt.id,
      origin,
      destination: evt.location,
      departure: new Date(evt.start),
      fromHome: lastLocation === null,
    });
    lastLocation = evt.location;
    lastEventEnd = evt.end;
  }

  if (lastLocation && lastEventEnd && homeAddress) {
    legs.push({
      eventId: null,
      origin: lastLocation,
      destination: homeAddress,
      departure: new Date(lastEventEnd),
      fromHome: false,
    });
  }

  if (legs.length === 0) return out;

  const redis = getRedis();
  const cacheKeys = legs.map((l) =>
    keys.fieldTravelLeg(travelLegBucketKey(l.origin, l.destination, l.departure)),
  );
  const cached = await redis.mget<(TravelLeg | null)[]>(...cacheKeys);

  const maps = getMaps();
  const resolved = await Promise.all(
    legs.map(async (leg, i) => {
      if (cached[i]) return cached[i];
      const fresh = await maps.getTravelTime(leg.origin, leg.destination, {
        departureTime: leg.departure,
      });
      if (fresh) {
        await redis.set(cacheKeys[i], fresh, { ex: ttl.fieldTravelLeg });
      }
      return fresh;
    }),
  );

  legs.forEach((leg, i) => {
    const est = resolved[i];
    if (!est) return;
    const travel: DayTravelLeg = {
      durationSec: est.durationSec,
      distanceMeters: est.distanceMeters,
      fromHome: leg.fromHome,
    };
    if (leg.eventId) {
      out.byEvent.set(leg.eventId, travel);
    } else {
      out.backHome = travel;
    }
  });

  return out;
}

/**
 * Adapter exposed for callers (e.g., scheduling proposal-builder running in
 * apps/middleware can adapt its own Redis client; this is the field-app
 * wrapper around the shared `getTravelLeg`).
 */
export async function fieldGetTravelLeg(
  origin: string,
  destination: string,
  departure: Date,
): Promise<TravelLeg | null> {
  const redis = getRedis();
  return getTravelLeg(origin, destination, departure, {
    maps: getMaps(),
    cache: {
      get: (key) => redis.get<TravelLeg>(key),
      set: (key, value, ttlSec) => redis.set(key, value, { ex: ttlSec }),
    },
  });
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
