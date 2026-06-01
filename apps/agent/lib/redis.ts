/**
 * Operational Redis layer for apps/agent.
 *
 * Mirrors apps/middleware/lib/redis.ts: this file holds the operations,
 * the key schema lives in @aac/shared-utils/redis. Same Redis instance
 * as middleware — agent uses the `agent:*` keyspace plus reads
 * `health:errors` from middleware for the error-surface cron.
 */

import { Redis } from '@upstash/redis';
import { keys, ttl } from '@aac/shared-utils/redis';
import { createLogger } from '@aac/shared-utils/logger';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import type { StoredProposal } from '@aac/scheduling';
import { getEnv } from './env.js';
import type { AgentRole } from './roles.js';

const log = createLogger('agent:redis');

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    const env = getEnv();
    redisClient = new Redis({
      url: env.redis.url,
      token: env.redis.token,
    });
  }
  return redisClient;
}

// ── Health ──────────────────────────────────────────────────────────

export async function writeHeartbeat(): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.heartbeat('agent'), new Date().toISOString());
}

// ── QuickBooks OAuth tokens (shared with middleware) ────────────────
//
// Same `keys.qbOAuthTokens` slot middleware writes to. The QB client
// reads/refreshes via these callbacks; both apps consume the same
// rolling refresh-token, so whichever app refreshes last wins.

export async function getQBTokens(): Promise<QBOAuthTokens | null> {
  const redis = getRedis();
  const data = await redis.get<QBOAuthTokens>(keys.qbOAuthTokens);
  return data || null;
}

export async function storeQBTokens(tokens: QBOAuthTokens): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.qbOAuthTokens, tokens);
  log.debug('Stored QB OAuth tokens');
}

// ── Cron cursors ────────────────────────────────────────────────────

/**
 * Read a cron-job cursor (e.g. the last surfaced error index for the
 * error-surface tick). Null if never written.
 */
export async function getCronCursor(job: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.agentCronCursor(job));
}

export async function setCronCursor(job: string, value: string): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.agentCronCursor(job), value);
  log.debug('Updated cron cursor', { job, value });
}

// ── Middleware health-error stream (READ-ONLY from agent) ───────────

export interface HealthErrorEntry {
  timestamp: string;
  source: string;
  message: string;
  details?: Record<string, unknown> | string;
  /**
   * Middleware deploy SHA at the time the error was logged. Used by the
   * error-surface tick to scope dedup per-deploy (so a fix-and-deploy
   * resets dedup and Matt finds out whether the fix held).
   */
  commitSha?: string;
}

/**
 * Claim "we already SMS'd Matt about this error on this deploy". Returns
 * true iff this is the first time we're surfacing this fingerprint on
 * this commit SHA. 24h TTL — even without a redeploy, the same error
 * eventually resurfaces.
 *
 * The dedup namespace is (commitSha, fingerprint). When middleware ships
 * a new deploy, the SHA changes and previously-silenced errors resurface
 * naturally — that's how Matt knows whether a fix worked.
 */
export async function claimErrorSurfaceNotification(
  commitSha: string,
  fingerprint: string,
): Promise<boolean> {
  const redis = getRedis();
  const key = keys.dedupe('error-surface', `${commitSha}:${fingerprint}`);
  const result = await redis.set(key, 'sent', { nx: true, ex: ttl.dedupe });
  return result === 'OK';
}

/**
 * Read the last `limit` entries from middleware's health:errors list.
 * Entries are JSON-encoded strings in a Redis LIST (LPUSH'd by
 * middleware's logHealthError, capped at 100 by LTRIM).
 *
 * Returns newest first (index 0 = most recent), matching middleware
 * convention. Bad entries are skipped with a warning.
 */
export async function readRecentHealthErrors(limit: number = 50): Promise<HealthErrorEntry[]> {
  const redis = getRedis();
  const raw = await redis.lrange(keys.healthErrors, 0, limit - 1);

  const out: HealthErrorEntry[] = [];
  for (const entry of raw) {
    try {
      const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
      if (parsed && typeof parsed === 'object' && 'timestamp' in parsed && 'source' in parsed && 'message' in parsed) {
        out.push(parsed as HealthErrorEntry);
      }
    } catch (err) {
      log.warn('Skipping malformed health error entry', { error: (err as Error).message });
    }
  }
  return out;
}

// ── Agent webhook dedup ─────────────────────────────────────────────
//
// The agent's Quo webhook is configured to fire only for the agent
// comms line (+16177660151) — middleware's Quo webhook never sees those
// events. Even so, we use a SEPARATE dedup source (`quo-agent`) so
// future cross-pollination (e.g. if both webhooks accidentally subscribe
// to the same line) can't cause one app's dedup to silently swallow the
// other's first-time events.

/**
 * Mark a Quo webhook event as processed for the agent. Returns true if
 * this is a NEW event (SET NX), false if we've seen it within the last
 * 24h.
 */
export async function markAgentQuoEventProcessed(eventId: string): Promise<boolean> {
  const redis = getRedis();
  const key = keys.dedupe('quo-agent', eventId);
  const result = await redis.set(key, 'processed', { nx: true, ex: ttl.dedupe });
  return result === 'OK';
}

// ── Audit log ───────────────────────────────────────────────────────
//
// One entry per inbound text the agent inspected. Capped LIST (LPUSH +
// LTRIM) rather than a stream because (a) we don't need consumer-group
// semantics, (b) LRANGE-based reads from Command Center are simpler,
// and (c) it matches the existing `health:errors` pattern.

/** Capacity of the audit log. Oldest entries past this are LTRIM'd. */
const AGENT_AUDIT_MAX_ENTRIES = 1000;

export type AgentAuditDecision =
  | 'ack'
  | 'ignore'
  | 'unknown_caller'
  | 'duplicate'
  | 'wrong_line'
  | 'unsupported_event'
  | 'proposal_received'
  | 'proposal_decision';

export interface AgentAuditEntry {
  /** ISO 8601 timestamp of when the agent processed the event */
  timestamp: string;
  /** Caller's E.164 phone, or `'unknown'` when we couldn't extract one */
  caller: string;
  /** Resolved role at time of processing, or `'unknown'` if not in role map */
  role: AgentRole | 'unknown';
  /** Verbatim inbound text (truncated to 500 chars to bound size) */
  inboundText: string;
  /** What the agent did */
  decision: AgentAuditDecision;
  /** Reply text the agent sent back, when applicable */
  replyText?: string;
  /** Quo event ID (for cross-referencing webhook logs) */
  eventId: string;
}

const AGENT_AUDIT_TEXT_MAX = 500;

// ── Scheduling proposals ────────────────────────────────────────────
//
// Middleware POSTs a proposal here; we stash it, send Matt the SMS, and
// wait for his reply. Matt's reply lands on the existing quo-webhook;
// the inbound handler looks up the active proposal for his phone, calls
// the proposal-reply module, which calls back to middleware.

/**
 * Store a proposal AND set the reverse index pointing to it. Both keys
 * carry the 24h TTL — Matt typically replies same day; stale proposals
 * just expire. Returns whether this proposal id is new (true) or an
 * idempotent retry from middleware (false).
 */
export async function writeProposal(proposal: StoredProposal): Promise<boolean> {
  const redis = getRedis();
  const stored = await redis.set(
    keys.agentProposal(proposal.proposalId),
    JSON.stringify(proposal),
    { nx: true, ex: ttl.agentProposal },
  );
  if (stored !== 'OK') return false;
  // Overwrite the active pointer: newest proposal wins. The previous
  // proposal stays addressable by id but won't be the default target of
  // Matt's reply. This is intentional simplicity for Walk #6.
  await redis.set(
    keys.agentActiveProposalForOwner(proposal.ownerPhoneE164),
    proposal.proposalId,
    { ex: ttl.agentProposal },
  );
  return true;
}

export async function getProposalById(proposalId: string): Promise<StoredProposal | null> {
  const redis = getRedis();
  const raw = await redis.get<string | StoredProposal>(keys.agentProposal(proposalId));
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredProposal;
    } catch (err) {
      log.warn('Failed to parse stored proposal', { proposalId, err: (err as Error).message });
      return null;
    }
  }
  return raw;
}

export async function getActiveProposalForOwner(ownerPhoneE164: string): Promise<StoredProposal | null> {
  const redis = getRedis();
  const proposalId = await redis.get<string>(keys.agentActiveProposalForOwner(ownerPhoneE164));
  if (!proposalId) return null;
  return getProposalById(proposalId);
}

export async function clearActiveProposalForOwner(ownerPhoneE164: string): Promise<void> {
  const redis = getRedis();
  await redis.del(keys.agentActiveProposalForOwner(ownerPhoneE164));
}

export async function appendAgentAuditEntry(entry: AgentAuditEntry): Promise<void> {
  const safeInbound =
    entry.inboundText.length > AGENT_AUDIT_TEXT_MAX
      ? entry.inboundText.slice(0, AGENT_AUDIT_TEXT_MAX) + '...'
      : entry.inboundText;
  const safeReply =
    entry.replyText && entry.replyText.length > AGENT_AUDIT_TEXT_MAX
      ? entry.replyText.slice(0, AGENT_AUDIT_TEXT_MAX) + '...'
      : entry.replyText;

  const payload: AgentAuditEntry = {
    ...entry,
    inboundText: safeInbound,
    ...(safeReply !== undefined ? { replyText: safeReply } : {}),
  };

  const redis = getRedis();
  await redis.lpush(keys.agentAuditStream, JSON.stringify(payload));
  await redis.ltrim(keys.agentAuditStream, 0, AGENT_AUDIT_MAX_ENTRIES - 1);
}
