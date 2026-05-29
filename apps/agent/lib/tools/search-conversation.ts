/**
 * Tool: searchConversation
 *
 * Returns Quo SMS history with a specific contact, optionally narrowed by
 * a case-insensitive substring query. Resolves the participant phone from
 * either a PD personId (looks up primary phone) or an explicit E.164 phone.
 *
 * The model uses this to recall what was said in a specific conversation
 * — e.g. "did Jane confirm Friday?", "what did Bob ask about scope?".
 */

import { toQuoMessageSummary, type QuoMessageSummary, type ToolDeps } from './types.js';

export interface SearchConversationInput {
  personId?: number;
  /** E.164. Used directly if given; otherwise we pull it from PD via personId. */
  phone?: string;
  /** Case-insensitive substring filter. If absent, returns most recent N messages. */
  query?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_FETCH = 200;

export async function searchConversation(
  deps: ToolDeps,
  input: SearchConversationInput,
): Promise<QuoMessageSummary[]> {
  if (input.personId === undefined && !input.phone) {
    throw new Error('searchConversation requires either personId or phone');
  }

  let phone = input.phone;
  if (!phone && input.personId !== undefined) {
    const person = await deps.pd.getPerson(input.personId);
    if (!person) return [];
    phone =
      person.phone?.find((p) => p.primary)?.value ??
      person.phone?.[0]?.value;
  }
  if (!phone) return [];

  const limit = input.limit ?? DEFAULT_LIMIT;
  // Fetch a wider window when filtering, so substring hits aren't starved
  // by the most-recent N already not matching.
  const fetchSize = input.query ? Math.min(MAX_FETCH, Math.max(limit * 4, 100)) : limit;

  const page = await deps.quo.listMessages({
    participantE164: phone,
    maxResults: fetchSize,
  });

  let messages = page.data ?? [];
  if (input.query) {
    const needle = input.query.toLowerCase();
    messages = messages.filter((m) => m.text.toLowerCase().includes(needle));
  }

  return messages.slice(0, limit).map(toQuoMessageSummary);
}
