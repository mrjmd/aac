/**
 * Google Ads offline conversions, run by hand (backfill, dry runs).
 * The daily run lives in the worker; this is the same package call.
 *
 *   npx tsx tools/src/ads-conversions/run.ts                 # dry, 3 days
 *   npx tsx tools/src/ads-conversions/run.ts --days 90       # dry backfill
 *   npx tsx tools/src/ads-conversions/run.ts --days 90 --live
 */
import { runAdsConversions } from '@aac/ads-conversions';
import { analyticsFromEnv, dataManagerFromEnv, googleAdsFromEnv, loadEnv, quickBooksFromEnv, quoFromEnv, redisFromEnv, requireEnv } from '../lib/env.js';

loadEnv();
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 3;
const redis = redisFromEnv();
const summary = await runAdsConversions(
  {
    ga: analyticsFromEnv(),
    quo: quoFromEnv(),
    qb: quickBooksFromEnv(redis),
    ads: googleAdsFromEnv(),
    dataManager: dataManagerFromEnv(),
    adsAccount: {
      customerId: requireEnv('GOOGLE_ADS_CUSTOMER_ID'),
      loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    },
    redis,
    ownLine: requireEnv('QUO_PHONE_NUMBER'),
    now: () => Date.now(),
    log: (line) => console.log(line),
  },
  { mode: args.includes('--live') ? 'live' : 'dry', lookbackDays: days },
);
console.log(JSON.stringify(summary, null, 2));
