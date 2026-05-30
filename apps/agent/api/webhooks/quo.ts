/**
 * Agent comms inbound webhook (Quo / OpenPhone).
 *
 * Subscribed to the dedicated agent line (`(617) 766-0151`). Every text
 * Matt (or another mapped user) sends to that line lands here.
 *
 * Walk step 1 pipeline:
 *   raw POST → HMAC verify → JSON parse → dedup → core handler
 *
 * The core handler (`lib/inbound-handler.ts`) owns the routing logic;
 * this file owns the HTTP/transport concerns. We use Web Standard API
 * (export POST returning Response) to get reliable raw-body access via
 * `request.text()` — required for HMAC verification. Same pattern as
 * `apps/middleware/api/webhooks/quo.ts`.
 *
 * Failure policy: always return 200 to the webhook sender once the
 * signature passes, so OpenPhone doesn't retry and double-process.
 * Internal failures are logged via the audit log and the agent's own
 * error path.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { verifyOpenPhoneWebhookSignature } from '@aac/shared-utils/webhook-signature';
import { getEnv } from '../../lib/env.js';
import { getQuo } from '../../lib/clients.js';
import {
  appendAgentAuditEntry,
  markAgentQuoEventProcessed,
  getActiveProposalForOwner,
  clearActiveProposalForOwner,
} from '../../lib/redis.js';
import {
  handleInboundAgentMessage,
  type ParsedInboundEvent,
} from '../../lib/inbound-handler.js';
import { postProposalDecision } from '../../lib/middleware-callback.js';

const log = createLogger('agent:quo-webhook');

// Quo event payload — only the fields the agent needs. Full schema lives
// in `apps/middleware/api/webhooks/quo.ts`; if you find yourself adding
// fields here that the middleware also reads, refactor toward a shared
// type in `@aac/api-clients/quo` instead of duplicating.
interface QuoWebhookEnvelope {
  object?: {
    id?: string;
    type?: string;
    data?: {
      object?: {
        id?: string;
        direction?: 'incoming' | 'outgoing';
        from?: string;
        to?: string;
        body?: string;
        conversationId?: string;
      };
    };
  };
}

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  if (!env.quo.webhookSecret) {
    log.error('QUO_WEBHOOK_SECRET not configured; refusing to accept webhooks', new Error('missing webhook secret'));
    return json({ error: 'Webhook secret not configured' }, 503);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('openphone-signature') || undefined;

  let signaturePassed = verifyOpenPhoneWebhookSignature(
    rawBody,
    signature,
    env.quo.webhookSecret,
  );

  if (!signaturePassed) {
    // Fallback: re-serialized body, in case edge middleware re-encoded
    // the bytes. Same defensive try as middleware/quo.ts.
    try {
      const reserialized = JSON.stringify(JSON.parse(rawBody));
      if (reserialized !== rawBody) {
        signaturePassed = verifyOpenPhoneWebhookSignature(
          reserialized,
          signature,
          env.quo.webhookSecret,
        );
      }
    } catch {
      // rawBody wasn't valid JSON; nothing to retry against
    }
  }

  if (!signaturePassed) {
    log.warn('Invalid agent webhook signature', {
      bodyLength: rawBody.length,
      hasSignature: !!signature,
    });
    return json({ error: 'Invalid signature' }, 401);
  }

  let payload: QuoWebhookEnvelope;
  try {
    payload = JSON.parse(rawBody) as QuoWebhookEnvelope;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Quo wraps the event in `object`; legacy/unwrapped form is also
  // accepted for safety. We do NOT log full payloads to keep customer
  // text out of vercel logs.
  const rawTop = payload as unknown as Record<string, unknown>;
  let evt: QuoWebhookEnvelope['object'];
  if (rawTop?.object && typeof rawTop.object === 'object') {
    evt = rawTop.object as QuoWebhookEnvelope['object'];
  } else if (rawTop?.id && rawTop?.type) {
    evt = rawTop as unknown as QuoWebhookEnvelope['object'];
  } else {
    log.warn('Invalid agent webhook payload structure', {
      keys: Object.keys(rawTop || {}),
    });
    return json({ error: 'Invalid payload' }, 400);
  }

  const eventData = evt?.data?.object;
  if (!evt?.id || !evt?.type || !eventData) {
    return json({ error: 'Invalid payload' }, 400);
  }

  log.info('Agent webhook received', { eventId: evt.id, type: evt.type });

  try {
    const isNew = await markAgentQuoEventProcessed(evt.id);
    if (!isNew) {
      log.info('Duplicate agent event ignored', { eventId: evt.id });
      // Audit the duplicate so Command Center can see retries / loops
      await appendAgentAuditEntry({
        timestamp: new Date().toISOString(),
        caller: eventData.from ?? 'unknown',
        role: 'unknown',
        inboundText: eventData.body ?? '',
        decision: 'duplicate',
        eventId: evt.id,
      });
      return json({ status: 'ignored', reason: 'duplicate' });
    }

    const parsed: ParsedInboundEvent = {
      eventId: evt.id,
      type: evt.type,
      to: eventData.to,
      from: eventData.from,
      body: eventData.body ?? '',
      messageId: eventData.id ?? evt.id,
      conversationId: eventData.conversationId,
    };

    const result = await handleInboundAgentMessage(parsed, {
      quo: getQuo(),
      audit: appendAgentAuditEntry,
      agentPhoneNumber: env.quo.agentPhoneNumber,
      roleMap: env.userRoles,
      proposalReply: {
        getActiveProposalForOwner,
        clearActiveProposalForOwner,
        postDecisionCallback: (payload) =>
          postProposalDecision(payload, {
            middlewareBaseUrl: env.scheduling.middlewareBaseUrl,
            proposalSecret: env.scheduling.proposalSecret,
          }),
      },
    });

    return json({ status: 'processed', decision: result.decision });
  } catch (err) {
    log.error('Agent webhook handler failed', err as Error, { eventId: evt.id });
    // Per Quo handling convention: don't surface 5xx, which would cause
    // retries that double-process. Log + 200.
    return json({ status: 'error', message: 'Processing failed, logged' });
  }
}
