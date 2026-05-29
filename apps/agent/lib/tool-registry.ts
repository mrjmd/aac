/**
 * Role-scoped tool registry for apps/agent.
 *
 * Wraps @aac/agent-tools' owner toolset with apps/agent's role enum. The
 * LLM session for a caller is only registered with the tools that caller
 * is allowed to use; the model never sees definitions for actions it
 * can't take or data it can't read.
 *
 * Today only `owner` has a populated registry — technician, salesperson,
 * and triage return empty arrays. Their tool scopes get fleshed out when
 * those roles actually get used; designing them now would be YAGNI.
 */

import {
  buildOwnerToolDefinitions,
  type ToolConfig,
  type ToolDefinition,
  type ToolDeps,
} from '@aac/agent-tools';
import type { AgentRole } from './roles.js';

export type { ToolDefinition, ToolDeps, ToolConfig };

/**
 * Build the LLM tool registry for a given caller role. Returns an empty
 * array for any role that doesn't have a concrete tool scope yet —
 * technician, salesperson, triage are placeholders per spec.
 */
export function buildToolRegistry(
  role: AgentRole,
  deps: ToolDeps,
  config: ToolConfig,
): Array<ToolDefinition<unknown, unknown>> {
  switch (role) {
    case 'owner':
      return buildOwnerToolDefinitions(deps, config);
    case 'technician':
    case 'salesperson':
    case 'triage':
      return [];
  }
}
