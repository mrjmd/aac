/**
 * Wiring for the Google Ads offline-conversion run. GA4, Ads and Data
 * Manager share one OAuth client whose refresh token carries adwords +
 * datamanager + analytics.readonly (the worker's GOOGLE_REFRESH_TOKEN has none). Returns null when the
 * Ads env isn't set, so the endpoint degrades to a logged skip.
 */
import { DataManagerClient } from '@aac/api-clients/data-manager';
import { GoogleAdsClient } from '@aac/api-clients/google-ads';
import { GoogleAnalyticsClient } from '@aac/api-clients/google-analytics';
import type { AdsConversionsDeps, AdsConversionsMode } from '@aac/ads-conversions';
import { createLogger } from '@aac/shared-utils/logger';
import { getWorkerDeps } from './deps.js';

const log = createLogger('worker-ads-conversions');

const MODES: readonly AdsConversionsMode[] = ['off', 'dry', 'live'];

/** ADS_CONVERSIONS_MODE (off | dry | live), default off. */
export function adsMode(): AdsConversionsMode {
  const raw = process.env.ADS_CONVERSIONS_MODE as AdsConversionsMode | undefined;
  return raw && MODES.includes(raw) ? raw : 'off';
}

let cached: AdsConversionsDeps | null | undefined;
let cachedAds: GoogleAdsClient | null | undefined;

/** The Google Ads client alone (the scorecard's spend), or null without the Ads env. */
export function adsClient(): GoogleAdsClient | null {
  if (cachedAds !== undefined) return cachedAds;
  const env = process.env;
  const need = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];
  cachedAds = need.some((k) => !env[k])
    ? null
    : new GoogleAdsClient({
        clientId: env.GOOGLE_ADS_CLIENT_ID as string,
        clientSecret: env.GOOGLE_ADS_CLIENT_SECRET as string,
        refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN as string,
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN as string,
        customerId: env.GOOGLE_ADS_CUSTOMER_ID as string,
        loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      });
  return cachedAds;
}

export function getAdsDeps(): AdsConversionsDeps | null {
  if (cached !== undefined) return cached;
  const env = process.env;
  const need = [
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID',
    'GA4_PROPERTY_ID',
    'QUO_PHONE_NUMBER',
  ];
  if (need.some((k) => !env[k])) {
    cached = null;
    return cached;
  }
  const oauth = {
    clientId: env.GOOGLE_ADS_CLIENT_ID as string,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET as string,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN as string,
  };
  const { deps, redis } = getWorkerDeps();
  cached = {
    ga: new GoogleAnalyticsClient({ propertyId: env.GA4_PROPERTY_ID as string, oauth }),
    ads: adsClient() as GoogleAdsClient,
    dataManager: new DataManagerClient(oauth),
    adsAccount: {
      customerId: env.GOOGLE_ADS_CUSTOMER_ID as string,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    },
    quo: deps.quo,
    qb: deps.qb,
    redis,
    ownLine: env.QUO_PHONE_NUMBER as string,
    now: () => Date.now(),
    log: (line) => log.info(line),
  };
  return cached;
}
