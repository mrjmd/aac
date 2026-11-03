/**
 * T4 scope-change gate (2026-10-29): given an open quote and new inbound
 * content (text / voicemail transcript / call transcript / email), decide
 * whether the content plausibly changes the quote's scope or price.
 *
 * Tuned for RECALL: a false positive costs one regeneration of an
 * untouched bot draft or one stray review note; a false negative is a
 * wrong quote going out (the Kshitij Bichave finished-basement miss,
 * 2026-10-28). When unsure, the gate says yes.
 */
import type { OpenQuoteEntry } from '@aac/shared-utils/types';
import type { DraftThreadMessage } from '@aac/quoting';
import { generateWithRetry } from './gemini.js';
import type { DrafterDeps } from './types.js';

export interface GateVerdict {
  scopeRelevant: boolean;
  /** One line: WHAT the new info is and why it matters (or doesn't). */
  reason: string;
}

export function buildScopeGatePrompt(args: {
  open: OpenQuoteEntry;
  /** The new inbound content, one block per event, already labeled by channel. */
  newContent: string[];
  /** Recent prior thread for context (oldest first). */
  context: DraftThreadMessage[];
}): string {
  const { open, newContent, context } = args;
  return [
    'You screen inbound customer communications for Attack A Crack (basement crack injection and concrete resurfacing).',
    'An open quote already exists for this customer:',
    `Quote #${open.docNumber} — $${open.total}`,
    `Lines: ${open.linesSummary || '(none recorded)'}`,
    '',
    'Recent conversation context (oldest first):',
    ...context.map((m) => `[${m.direction === 'incoming' ? 'CUSTOMER' : 'US'}] ${m.text}`),
    '',
    'NEW inbound communication to judge:',
    ...newContent,
    '',
    'Question: does the NEW communication contain information that plausibly affects the scope, pricing, materials, site conditions, or access for this quote? Examples that DO: finished vs unfinished space (drywall/framing removal), additional cracks or areas, square footage changes, water/moisture details, structural observations, requests to add or drop work. Examples that do NOT: scheduling and availability, payment logistics, pleasantries, confirmations, questions already answered by the quote.',
    'If it plausibly affects the quote, answer yes — only answer no when the content is clearly irrelevant to scope or price.',
    'Respond with JSON only, no prose, no code fences:',
    '{"scopeRelevant": true|false, "reason": "<one line: what the new info is and why it matters / does not>"}',
  ].join('\n');
}

export function parseGateVerdict(raw: string): GateVerdict | null {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.scopeRelevant !== 'boolean') return null;
    return {
      scopeRelevant: parsed.scopeRelevant,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    };
  } catch {
    return null;
  }
}

export async function runScopeGate(
  deps: Pick<DrafterDeps, 'gemini' | 'log'>,
  args: Parameters<typeof buildScopeGatePrompt>[0],
): Promise<GateVerdict | null> {
  const raw = await generateWithRetry(deps.gemini, buildScopeGatePrompt(args), {});
  const verdict = parseGateVerdict(raw);
  if (!verdict) deps.log(`  ⚠ T4 gate unparseable: ${raw.slice(0, 120).replace(/\n/g, ' ')}`);
  return verdict;
}
