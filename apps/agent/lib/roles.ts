/**
 * Role lookup for inbound-text identity binding.
 *
 * Identity is by phone number: whoever texts the comms line is the user
 * whose E.164 number appears in AGENT_USER_ROLES. Unknown numbers get
 * role=null and the handler decides what to do (typically: ignore).
 *
 * Only `owner` has a concretely defined tool scope at Crawl + Walk start.
 * The other roles are placeholders — the map can route them, but their
 * tool surfaces get fleshed out when the people actually start using
 * the agent. (Per spec: aspirational scopes are YAGNI right now.)
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('agent:roles');

export const AGENT_ROLES = ['owner', 'technician', 'salesperson', 'triage'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value);
}

/**
 * Parse the AGENT_USER_ROLES env var. Format: JSON object mapping E.164
 * phones to roles, e.g. `{"+15551234567":"owner","+15557654321":"technician"}`.
 *
 * Invalid JSON → empty map + warning. Unknown role values → skipped (the
 * other entries still load). Missing env → empty map (no users mapped).
 *
 * The agent runs fine with an empty role map — every inbound text would
 * just be unauthenticated. So we don't throw on a bad value; we log and
 * keep going.
 */
export function parseAgentUserRoles(raw: string | undefined): Record<string, AgentRole> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('AGENT_USER_ROLES is not valid JSON; treating as empty', {
      error: (err as Error).message,
    });
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('AGENT_USER_ROLES is not an object; treating as empty');
    return {};
  }

  const out: Record<string, AgentRole> = {};
  for (const [phone, role] of Object.entries(parsed)) {
    if (!isAgentRole(role)) {
      log.warn('Skipping AGENT_USER_ROLES entry with unknown role', { phone, role });
      continue;
    }
    out[phone] = role;
  }
  return out;
}

/** Look up the role for an E.164 phone. Returns null if not mapped. */
export function lookupRole(
  phoneE164: string,
  roleMap: Record<string, AgentRole>
): AgentRole | null {
  return roleMap[phoneE164] ?? null;
}
