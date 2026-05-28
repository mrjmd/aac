/**
 * Google Maps Platform client — Distance Matrix only (for now).
 *
 * Used by apps/field to estimate drive time between consecutive jobs on the
 * tech's schedule. Server-side only — the API key is never sent to the
 * browser.
 *
 * Auth model differs from the other Google clients in this package: Maps
 * Platform uses raw API keys (no OAuth). Restrict the key at Cloud Console
 * (API restriction = Distance Matrix only, plus a budget cap).
 *
 * Docs: https://developers.google.com/maps/documentation/distance-matrix
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('google-maps');

export interface GoogleMapsConfig {
  apiKey: string;
}

export interface TravelEstimate {
  /** Drive duration in seconds. Includes traffic when {@link GetTravelTimeOptions.departureTime} is set. */
  durationSec: number;
  /** Distance in meters. */
  distanceMeters: number;
}

export interface GetTravelTimeOptions {
  /**
   * Departure time for traffic-aware estimates. Pass a future Date (or
   * 'now') to get a `duration_in_traffic` reading. Omit for an average
   * non-traffic estimate.
   */
  departureTime?: Date | 'now';
  /** Defaults to 'driving'. */
  mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
}

interface DistanceMatrixElement {
  status: string;
  distance?: { value: number; text: string };
  duration?: { value: number; text: string };
  duration_in_traffic?: { value: number; text: string };
}

interface DistanceMatrixResponse {
  status: string;
  error_message?: string;
  origin_addresses: string[];
  destination_addresses: string[];
  rows: { elements: DistanceMatrixElement[] }[];
}

export class GoogleMapsClient {
  constructor(private config: GoogleMapsConfig) {}

  /**
   * Get a single origin→destination drive estimate. Returns null if the
   * Maps API can't compute a route (typo, unreachable, etc.) — callers
   * should treat null as "unknown drive time, show nothing".
   */
  async getTravelTime(
    origin: string,
    destination: string,
    options: GetTravelTimeOptions = {},
  ): Promise<TravelEstimate | null> {
    const mode = options.mode ?? 'driving';
    const params = new URLSearchParams({
      origins: origin,
      destinations: destination,
      mode,
      units: 'imperial',
      key: this.config.apiKey,
    });
    if (options.departureTime) {
      const depTime =
        options.departureTime === 'now'
          ? 'now'
          : String(Math.max(Math.floor(options.departureTime.getTime() / 1000), Math.floor(Date.now() / 1000)));
      params.set('departure_time', depTime);
      params.set('traffic_model', 'best_guess');
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      log.warn('Distance Matrix network error', { origin, destination, err: String(err) });
      return null;
    }
    if (!resp.ok) {
      log.warn('Distance Matrix non-200', { origin, destination, status: resp.status });
      return null;
    }
    const data = (await resp.json()) as DistanceMatrixResponse;
    if (data.status !== 'OK') {
      log.warn('Distance Matrix top-level error', { origin, destination, status: data.status, message: data.error_message });
      return null;
    }
    const element = data.rows[0]?.elements[0];
    if (!element || element.status !== 'OK' || !element.duration || !element.distance) {
      log.warn('Distance Matrix element error', { origin, destination, elementStatus: element?.status });
      return null;
    }
    const durationSec = element.duration_in_traffic?.value ?? element.duration.value;
    return {
      durationSec,
      distanceMeters: element.distance.value,
    };
  }
}
