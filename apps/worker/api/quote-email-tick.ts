/**
 * T4 email channel poll (route: /api/quote-email-tick, Vercel cron every
 * 15 min). Gmail has no webhook here — this tick matches recent inbound
 * mail against the open-quote index and enqueues synthetic trigger events;
 * the per-minute quote-tick debounces and runs the scope gate as usual.
 *
 * Requires gmail.readonly on GOOGLE_REFRESH_TOKEN. Without the scope (or
 * the Google env at all) it degrades to a logged skip, never an error —
 * the other T4 channels are unaffected.
 */
import { GmailClient } from '@aac/api-clients/gmail';
import { createLogger } from '@aac/shared-utils/logger';
import { pollQuoteEmails, resolveMode } from '@aac/quote-drafter';
import { getQuoteDeps, envMode } from '../lib/quote-deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';
import { recordFailure, recordRun } from '../lib/health.js';

const log = createLogger('worker-quote-email-tick');

let gmail: GmailClient | null | undefined;

function getGmail(): GmailClient | null {
  if (gmail !== undefined) return gmail;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  gmail =
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN
      ? new GmailClient({
          oauth: {
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
            refreshToken: GOOGLE_REFRESH_TOKEN,
          },
        })
      : null;
  return gmail;
}

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const deps = getQuoteDeps();
    const mode = await resolveMode(deps, envMode());
    if (mode === 'off') return json({ status: 'ok', skipped: 'off' });
    const client = getGmail();
    if (!client) {
      log.warn('email channel disabled — no Google OAuth env');
      return json({ status: 'ok', skipped: 'no-google-env' });
    }
    const summary = await pollQuoteEmails({
      redis: deps.redis,
      gmail: client,
      log: (line) => log.info(line),
      now: () => Date.now(),
    });
    if (summary.enqueued) log.info('quote email tick', { ...summary });
    await recordRun('quote-email-tick', { sent: summary.enqueued, skipped: summary.scanned - summary.enqueued, errors: 0 });
    return json({ status: 'ok', mode, ...summary });
  } catch (err) {
    const msg = (err as Error).message;
    if (/insufficient|scope|403/i.test(msg)) {
      // Token minted without gmail.readonly — reauth via
      // tools/src/scratch/reauth-google.ts, then update the worker env.
      log.warn('email channel disabled — token lacks gmail.readonly', { error: msg.slice(0, 200) });
      return json({ status: 'ok', skipped: 'no-gmail-scope' });
    }
    log.error('quote email tick failed', err as Error);
    await recordFailure('quote-email-tick', `quote email tick failed: ${msg}`);
    return json({ status: 'error', message: msg }, 500);
  }
}
