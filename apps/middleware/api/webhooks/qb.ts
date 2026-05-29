/**
 * QuickBooks Webhook Handler — Estimate.Update
 *
 * Intuit fires this when an Estimate changes state (Pending → Accepted etc).
 * In Crawl scope we receive the event, fetch the full Estimate, run it
 * through `@aac/scheduling.normalizeQbApproval`, and shadow-queue the
 * resulting directive for review in apps/command-center. No calendar
 * writes, no customer SMS, no PD writes — this is the data-collection
 * stage of the SchedulingDirective pipeline.
 *
 * CloudEvents payload format (post-migration; legacy `eventNotifications`
 * shape ends 2026-07-31). One notification may contain multiple events.
 *
 * Signature: HMAC-SHA256 of raw body using the Webhook Verifier Token,
 * delivered base64-encoded in the `intuit-signature` header.
 *
 * Triggers:  POST from developer.intuit.com webhook subscription
 * Returns:   200 on success / receipt-with-error (Intuit shouldn't retry)
 *            401 on signature failure (config drift signal)
 */

import crypto from 'crypto';
import { createLogger } from '@aac/shared-utils/logger';
import { normalizeQbApproval } from '@aac/scheduling';
import { randomUUID } from 'crypto';
import { getEnv } from '../../lib/env.js';
import { getPipedrive, getQuickBooks, getQuo } from '../../lib/clients.js';
import {
  markEventProcessed,
  trackWebhookProcessed,
  logHealthError,
  writePendingDirective,
} from '../../lib/redis.js';

const log = createLogger('qb-webhook');

// ── CloudEvents shapes ────────────────────────────────────────────

interface QbCloudEvent {
  specversion: string;
  id: string;
  source: string;
  type: string;
  time?: string;
  intuitentityid?: string;
  intuitaccountid?: string;
  data?: unknown;
}

/** Defensive: accept array of events OR { events: [...] } wrapper. */
function extractEvents(payload: unknown): QbCloudEvent[] {
  if (Array.isArray(payload)) return payload as QbCloudEvent[];
  if (payload && typeof payload === 'object' && 'events' in payload) {
    const e = (payload as { events: unknown }).events;
    if (Array.isArray(e)) return e as QbCloudEvent[];
  }
  return [];
}

function isEstimateUpdate(evt: QbCloudEvent): boolean {
  const t = evt.type?.toLowerCase() ?? '';
  return t.includes('estimate') && t.includes('update');
}

// ── Signature verification ────────────────────────────────────────

/**
 * Verify Intuit's HMAC-SHA256 webhook signature.
 *
 * - Computes HMAC-SHA256(rawBody, verifierToken)
 * - Compares (timing-safe) against the base64 `intuit-signature` header
 * - Returns false on missing header / mismatch / malformed inputs
 */
export function verifyIntuitSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  verifierToken: string,
): boolean {
  if (!signatureHeader || !verifierToken) return false;
  const computed = crypto
    .createHmac('sha256', verifierToken)
    .update(rawBody, 'utf8')
    .digest('base64');
  const provided = Buffer.from(signatureHeader);
  const expected = Buffer.from(computed);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// ── Handler ───────────────────────────────────────────────────────

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  if (!env.quickbooks.webhookVerifierToken) {
    log.error('QB webhook hit but verifier token not configured', new Error('not_configured'));
    return json({ error: 'webhook not configured' }, 503);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('intuit-signature') || undefined;

  if (!verifyIntuitSignature(rawBody, signature, env.quickbooks.webhookVerifierToken)) {
    log.warn('Invalid QB webhook signature', {
      bodyLength: rawBody.length,
      hasSignature: !!signature,
    });
    return json({ error: 'Invalid signature' }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('Invalid JSON payload');
    return json({ error: 'Invalid JSON' }, 400);
  }

  const events = extractEvents(payload);
  if (events.length === 0) {
    log.info('No events in payload — acknowledging');
    return json({ status: 'no_events' });
  }

  const results = await Promise.allSettled(events.map((evt) => processEvent(evt)));
  await trackWebhookProcessed('qb');

  const counts = results.reduce(
    (acc, r) => {
      if (r.status === 'fulfilled') acc[r.value]++;
      else acc.error++;
      return acc;
    },
    { directive: 0, filtered: 0, duplicate: 0, ignored: 0, error: 0 },
  );
  log.info('QB webhook processed', counts);
  return json({ status: 'processed', counts });
}

type ProcessOutcome = 'directive' | 'filtered' | 'duplicate' | 'ignored';

async function processEvent(evt: QbCloudEvent): Promise<ProcessOutcome> {
  if (!isEstimateUpdate(evt)) {
    log.debug('Skipping non-estimate-update event', { type: evt.type });
    return 'ignored';
  }
  if (!evt.intuitentityid) {
    log.warn('Estimate event missing intuitentityid', { eventId: evt.id });
    return 'ignored';
  }

  const dedupId = evt.id || `${evt.type}:${evt.intuitentityid}:${evt.time ?? ''}`;
  const isNew = await markEventProcessed('qb', dedupId);
  if (!isNew) {
    log.debug('Duplicate QB event', { dedupId });
    return 'duplicate';
  }

  try {
    const qb = getQuickBooks();
    const estimate = await qb.getEstimate(evt.intuitentityid);
    if (!estimate) {
      log.warn('Estimate not found in QB', { estimateId: evt.intuitentityid });
      return 'ignored';
    }

    const directive = await normalizeQbApproval(
      {
        pd: getPipedrive(),
        qb,
        quo: getQuo(),
        newId: () => randomUUID(),
        now: () => new Date(),
      },
      { estimate },
    );

    if (!directive) {
      log.info('Estimate not in Accepted state — filtered', {
        estimateId: evt.intuitentityid,
        status: estimate.TxnStatus,
      });
      return 'filtered';
    }

    await writePendingDirective(directive);
    log.info('Shadow-queued scheduling directive', {
      directiveId: directive.id,
      estimateId: directive.qbEstimateId,
      confidence: directive.confidence.score,
    });
    return 'directive';
  } catch (err) {
    log.error('Failed to process QB event', err as Error, {
      eventId: evt.id,
      entityId: evt.intuitentityid,
    });
    await logHealthError('qb', (err as Error).message, { eventId: evt.id });
    return 'ignored';
  }
}
