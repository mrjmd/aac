/**
 * Hourly Gemini canary (route: /api/gemini-canary, Vercel cron at :07).
 * One tiny structured call on the client's default model (the
 * gemini-flash-latest alias) with GEMINI_API_KEY: a pass stamps
 * health:gemini-canary:ts, a failure counts `gemini.canary_failed`. The
 * watchdog's Gemini-degraded condition reads both (@aac/watchdog gemini.ts)
 * and is the only thing that texts; a failed canary is not a health error,
 * so the error-surface doesn't text it a second time.
 * Replaces the laptop triage's once-a-day D0 canary as the alarm.
 */
import { GeminiClient } from '@aac/api-clients/gemini';
import { createLogger } from '@aac/shared-utils/logger';
import { runGeminiCanary } from '@aac/watchdog';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { guarded, healthRedis, recordRun } from '../lib/health.js';

const log = createLogger('worker-gemini-canary');

export async function GET(request: Request): Promise<Response> {
  return guarded('gemini-canary', () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const redis = healthRedis();
  if (!redis) throw new Error('Upstash env not set');
  const key = process.env.GEMINI_API_KEY;
  const result = await runGeminiCanary({ gemini: key ? new GeminiClient({ apiKey: key }) : null, redis });
  if (!result.ok) log.error('gemini canary failed', undefined, { detail: result.detail });
  await recordRun('gemini-canary', { sent: result.ok ? 1 : 0, skipped: 0, errors: result.ok ? 0 : 1 });
  return json({ status: 'ok', canary: result.ok ? 'passed' : 'failed', detail: result.detail });
}
