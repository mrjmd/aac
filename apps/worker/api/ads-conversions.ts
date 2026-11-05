/**
 * Google Ads offline conversions (route: /api/ads-conversions, Vercel cron
 * daily). Matches yesterday's ad taps to new callers/texters and tells
 * Google which clicks became real leads, quotes and jobs
 * (docs/plans/google-ads-offline-conversions.md).
 *
 * Gated by ADS_CONVERSIONS_MODE (off | dry | live, default off). Without
 * the Ads env it's a logged skip. `?days=N` widens the lookback (max 90).
 */
import { runAdsConversions } from '@aac/ads-conversions';
import { createLogger } from '@aac/shared-utils/logger';
import { adsMode, getAdsDeps } from '../lib/ads-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-ads-conversions');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const mode = adsMode();
  if (mode === 'off') return json({ status: 'ok', skipped: 'off' });
  const deps = getAdsDeps();
  if (!deps) {
    log.warn('ads conversions disabled — Google Ads / GA4 env not set');
    return json({ status: 'ok', skipped: 'no-ads-env' });
  }
  const days = Number(new URL(request.url).searchParams.get('days'));
  const lookbackDays = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 3;
  try {
    const summary = await runAdsConversions(deps, { mode, lookbackDays });
    return json({ status: 'ok', ...summary });
  } catch (err) {
    log.error('ads conversions failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
