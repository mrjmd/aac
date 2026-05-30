/**
 * Middleware callback bridge — Walk #6.2.
 *
 * The agent POSTs the proposal decision (approved/rejected/edit) back
 * to middleware so it can record state, surface in command-center, and
 * (eventually, Walk #7) hand off to executeDirective.
 *
 * Auth: shared `SCHEDULING_PROPOSAL_SECRET` in the same header the
 * middleware → agent direction uses, so both sides can share one env
 * value.
 *
 * Return value: `true` if middleware acknowledged (any 2xx), `false`
 * otherwise. We never throw — the caller decides what to do with a
 * failure (the proposal-reply handler still ack's Matt).
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { ProposalDecisionPayload } from '@aac/scheduling';

const log = createLogger('agent:middleware-callback');

export interface MiddlewareCallbackDeps {
  middlewareBaseUrl: string | null;
  proposalSecret: string | null;
  fetch?: typeof globalThis.fetch;
}

const TIMEOUT_MS = 15_000;

export async function postProposalDecision(
  payload: ProposalDecisionPayload,
  deps: MiddlewareCallbackDeps,
): Promise<boolean> {
  if (!deps.middlewareBaseUrl || !deps.proposalSecret) {
    log.warn('Skipping middleware callback — base URL or secret unset', {
      hasUrl: !!deps.middlewareBaseUrl,
      hasSecret: !!deps.proposalSecret,
      proposalId: payload.proposalId,
    });
    return false;
  }

  const url = `${deps.middlewareBaseUrl.replace(/\/+$/, '')}/api/scheduling/proposal-decision`;
  const doFetch = deps.fetch ?? globalThis.fetch;

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-scheduling-proposal-secret': deps.proposalSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('Middleware callback non-2xx', new Error(`status ${res.status}`), {
        status: res.status,
        body: text.slice(0, 200),
        proposalId: payload.proposalId,
      });
      return false;
    }

    log.info('Middleware callback succeeded', {
      proposalId: payload.proposalId,
      decision: payload.decision,
    });
    return true;
  } catch (err) {
    log.error('Middleware callback threw', err as Error, {
      proposalId: payload.proposalId,
    });
    return false;
  }
}
