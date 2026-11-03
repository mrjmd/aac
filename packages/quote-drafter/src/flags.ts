/**
 * Scope-change flags (T4, 2026-10-29): when scope-relevant new info
 * arrives for a quote the bot must not touch (human-owned, or not
 * bot-created), the deliverable is a 🤖 Quo note + a triage flag — the
 * estimate itself is NEVER modified (SyncToken one-way door stands).
 */
import { buildScopeFlagNote } from '@aac/quoting';
import { keys } from '@aac/shared-utils/redis';
import type { DrafterDeps } from './types.js';

const SCOPE_FLAGS_MAX = 200;

export interface ScopeFlag {
  at: string;
  phone: string;
  customer: string;
  docNumber: string;
  estimateId: string;
  total: number;
  /** Gate verdict (T4) or trigger description (T1/T3 on a human-owned quote). */
  reason: string;
  /** 'text' | 'photos' | 'voicemail' | 'call transcript' | 'email' (or a + join). */
  channel: string;
}

/**
 * Record the flag (Redis list → triage section) and announce it on the
 * customer's Quo contact. Shadow mode logs what would happen and writes
 * nothing. Note failures never fail the flag — the list entry is the
 * durable record.
 */
export async function flagScopeChange(
  deps: Pick<DrafterDeps, 'redis' | 'quo' | 'log'>,
  flag: ScopeFlag,
  opts: { dryRun: boolean },
): Promise<void> {
  if (opts.dryRun) {
    deps.log(`  [shadow] would flag quote #${flag.docNumber} (${flag.channel}): ${flag.reason}`);
    return;
  }
  await deps.redis.lpush(keys.quoteScopeFlags, JSON.stringify(flag));
  await deps.redis.ltrim(keys.quoteScopeFlags, 0, SCOPE_FLAGS_MAX - 1);
  deps.log(`  ⚑ flagged quote #${flag.docNumber} (${flag.channel}): ${flag.reason}`);
  try {
    const contact = await deps.quo.findContactByPhone(flag.phone);
    if (!contact) {
      deps.log('  ~ no Quo contact for flag note — triage flag only');
      return;
    }
    await deps.quo.createContactNote(
      contact.id,
      buildScopeFlagNote({
        docNumber: flag.docNumber,
        estimateId: flag.estimateId,
        total: flag.total,
        reason: flag.reason,
        channel: flag.channel,
      }),
    );
    deps.log('  ✓ posted scope-flag Quo note');
  } catch (err) {
    deps.log(`  ⚠ scope-flag note failed (${(err as Error).message.slice(0, 80)}) — triage flag recorded`);
  }
}
