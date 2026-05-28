/**
 * Environment variable validation and access for apps/agent.
 *
 * Mirrors apps/middleware/lib/env.ts in style: a single getEnv() that
 * caches a typed config. Each handler reads from here; no handler reads
 * process.env directly.
 */

import type { AgentRole } from './roles.js';
import { parseAgentUserRoles } from './roles.js';

export interface AgentEnvConfig {
  pipedrive: {
    apiKey: string;
    companyDomain: string;
    systemUserId: string;
  };
  quo: {
    apiKey: string;
    /** Number the agent SENDS from (dedicated comms line). E.164. */
    agentPhoneNumber: string;
    webhookSecret: string | null;
  };
  notifications: {
    /** Matt's personal phone (E.164). Used as the whitelist target for owner messages. */
    mattPersonalPhone: string;
  };
  /** Phone (E.164) → role map for identity binding on inbound texts. */
  userRoles: Record<string, AgentRole>;
  cron: {
    secret: string | null;
  };
  redis: {
    url: string;
    token: string;
  };
  nodeEnv: 'development' | 'production';
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

let cached: AgentEnvConfig | null = null;

export function getEnv(): AgentEnvConfig {
  if (cached) return cached;

  cached = {
    pipedrive: {
      apiKey: requireEnv('PIPEDRIVE_API_KEY'),
      companyDomain: requireEnv('PIPEDRIVE_COMPANY_DOMAIN'),
      systemUserId: requireEnv('PIPEDRIVE_SYSTEM_USER_ID'),
    },
    quo: {
      apiKey: requireEnv('QUO_API_KEY'),
      agentPhoneNumber: process.env.QUO_AGENT_PHONE_NUMBER || '+16177660151',
      webhookSecret: process.env.QUO_WEBHOOK_SECRET || null,
    },
    notifications: {
      mattPersonalPhone: requireEnv('MATT_PERSONAL_PHONE_NUMBER'),
    },
    userRoles: parseAgentUserRoles(process.env.AGENT_USER_ROLES),
    cron: {
      secret: process.env.CRON_SECRET || null,
    },
    redis: {
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    },
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production') || 'development',
  };

  return cached;
}

export function isProduction(): boolean {
  return getEnv().nodeEnv === 'production';
}

/** Test-only: reset the cache. */
export function resetEnvCache(): void {
  cached = null;
}
