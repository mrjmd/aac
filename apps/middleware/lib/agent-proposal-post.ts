/**
 * HTTP bridge: middleware → apps/agent `/api/proposals`.
 *
 * Owns the shared-secret header + URL composition + timeout. Returns
 * `{ ok, status, smsId? }`. Never throws — callers (the admin
 * send-proposal trigger today; Walk #7 dispatch tomorrow) decide what
 * to do with a failure.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { ProposalPayload } from '@aac/scheduling';

const log = createLogger('agent-proposal-post');

const TIMEOUT_MS = 15_000;

export interface AgentProposalPostDeps {
  agentBaseUrl: string | null;
  proposalSecret: string | null;
  fetch?: typeof globalThis.fetch;
}

export interface AgentProposalPostResult {
  ok: boolean;
  status: number;
  smsId: string | null;
  bodyText: string | null;
}

export async function postProposalToAgent(
  payload: ProposalPayload,
  deps: AgentProposalPostDeps,
): Promise<AgentProposalPostResult> {
  if (!deps.agentBaseUrl || !deps.proposalSecret) {
    log.warn('Skipping agent post — base URL or secret unset', {
      hasUrl: !!deps.agentBaseUrl,
      hasSecret: !!deps.proposalSecret,
      proposalId: payload.proposalId,
    });
    return { ok: false, status: 0, smsId: null, bodyText: null };
  }

  const url = `${deps.agentBaseUrl.replace(/\/+$/, '')}/api/proposals`;
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

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      log.error('Agent post non-2xx', new Error(`status ${res.status}`), {
        status: res.status,
        body: text.slice(0, 200),
        proposalId: payload.proposalId,
      });
      return { ok: false, status: res.status, smsId: null, bodyText: text };
    }

    let smsId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { smsId?: string | null };
      smsId = parsed.smsId ?? null;
    } catch {
      // Body wasn't JSON; not fatal — agent endpoint did 200, that's what matters.
    }

    log.info('Agent post succeeded', {
      proposalId: payload.proposalId,
      status: res.status,
      smsId,
    });
    return { ok: true, status: res.status, smsId, bodyText: text };
  } catch (err) {
    log.error('Agent post threw', err as Error, { proposalId: payload.proposalId });
    return { ok: false, status: 0, smsId: null, bodyText: null };
  }
}
