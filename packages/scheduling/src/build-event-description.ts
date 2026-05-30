/**
 * buildEventDescription — turn a SchedulingDirective + customer facts +
 * Quo conversation history into the body text we'll write into the Google
 * Calendar event.
 *
 * Pure function: LLM client + clock arrive via `deps`. The caller (the
 * middleware dispatch helper for Walk #6/7) is responsible for gathering
 * the input facts (PD customer, QB line items, recent Quo messages). This
 * function owns: prompt, LLM call, quality gates, retries, fallback.
 *
 * Quality gates per [[ai-quality-gates]]:
 *   - address_present   if customer.address provided, output must reference it
 *   - line_item_referenced  if qbLineItems present, at least one must appear
 *   - no_hallucinated_facts  no phone/email/money strings absent from inputs
 *   - length_ok         ≤ MAX_LENGTH chars
 *
 * Failed gates trigger up to 2 retries with the failure fed back into the
 * prompt. If retries exhaust, we emit a deterministic template-only
 * description (usedFallback: true) so Matt always gets something usable.
 */

import type { GeminiClient } from '@aac/api-clients';
import { createLogger } from '@aac/shared-utils/logger';
import type { SchedulingDirective } from './types.js';

const log = createLogger('scheduling:build-event-description');

const MAX_LENGTH = 1200;
const MAX_RETRIES = 2;
const MAX_CONVERSATION_MESSAGES = 20;

export interface BuildEventDescriptionDeps {
  gemini: GeminiClient;
  now?: () => Date;
}

export interface EventDescriptionCustomer {
  name: string;
  address: string | null;
}

export interface EventDescriptionLineItem {
  description: string;
}

export interface EventDescriptionMessage {
  direction: 'incoming' | 'outgoing';
  text: string;
  at: string; // ISO
}

export interface BuildEventDescriptionInput {
  directive: SchedulingDirective;
  customer: EventDescriptionCustomer;
  qbLineItems?: EventDescriptionLineItem[];
  conversationHistory?: EventDescriptionMessage[];
  photosUrl?: string;
  accessNotes?: string;
}

export interface BuildEventDescriptionResult {
  description: string;
  qualityFlags: string[];
  usedFallback: boolean;
  attempts: number;
}

export async function buildEventDescription(
  deps: BuildEventDescriptionDeps,
  input: BuildEventDescriptionInput,
): Promise<BuildEventDescriptionResult> {
  const facts = collectFacts(input);
  const prunedConversation = pruneConversation(input.conversationHistory ?? []);

  let lastAttempt: { description: string; flags: string[] } | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const prompt = buildPrompt({
      facts,
      conversation: prunedConversation,
      input,
      previousAttempt: lastAttempt,
    });

    let raw: string;
    try {
      raw = await deps.gemini.generateContent(prompt, {
        temperature: 0.2,
        maxOutputTokens: 600,
      });
    } catch (err) {
      log.warn('Gemini call failed, will fall back', {
        attempt,
        error: (err as Error).message,
      });
      break;
    }

    const description = sanitize(raw);
    const flags = runQualityGates(description, facts);

    if (flags.length === 0) {
      log.info('Event description passed quality gates', { attempts: attempt });
      return {
        description,
        qualityFlags: [],
        usedFallback: false,
        attempts: attempt,
      };
    }

    lastAttempt = { description, flags };
    log.warn('Event description failed quality gates, will retry', {
      attempt,
      flags,
    });
  }

  const fallback = buildFallbackDescription(input);
  log.warn('Event description fell back to template', {
    failedFlags: lastAttempt?.flags ?? ['gemini_unavailable'],
  });
  return {
    description: fallback,
    qualityFlags: lastAttempt
      ? [...lastAttempt.flags, 'fallback_used']
      : ['gemini_unavailable', 'fallback_used'],
    usedFallback: true,
    attempts: MAX_RETRIES + 1,
  };
}

// ── facts + sanitization ────────────────────────────────────────────────

interface CollectedFacts {
  customerName: string;
  address: string | null;
  scopeSummary: string;
  intent: SchedulingDirective['intent'];
  eventClass: SchedulingDirective['eventClass'];
  lineItems: string[];
  photosUrl: string | null;
  accessNotes: string | null;
  durationLine: string | null;
}

function collectFacts(input: BuildEventDescriptionInput): CollectedFacts {
  const lineItems = (input.qbLineItems ?? [])
    .map((l) => l.description.trim())
    .filter((d) => d.length > 0);

  const dp = input.directive.durationPrediction;
  const durationLine = dp
    ? `~${dp.point}h (p25–p75: ${dp.p25}h–${dp.p75}h, ${dp.confidence} confidence)`
    : null;

  return {
    customerName: input.customer.name.trim(),
    address: input.customer.address?.trim() || null,
    scopeSummary: input.directive.scopeSummary.trim(),
    intent: input.directive.intent,
    eventClass: input.directive.eventClass,
    lineItems,
    photosUrl: input.photosUrl?.trim() || null,
    accessNotes: input.accessNotes?.trim() || null,
    durationLine,
  };
}

function pruneConversation(
  messages: EventDescriptionMessage[],
): EventDescriptionMessage[] {
  if (messages.length === 0) return [];
  const trimmed = messages
    .filter((m) => m.text && m.text.trim().length > 0)
    .slice(-MAX_CONVERSATION_MESSAGES);
  return trimmed;
}

function sanitize(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '');
  text = text.trim();
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH).trimEnd() + '…';
  }
  return text;
}

// ── quality gates ────────────────────────────────────────────────────────

function runQualityGates(description: string, facts: CollectedFacts): string[] {
  const flags: string[] = [];

  if (description.length === 0) {
    flags.push('empty_response');
    return flags;
  }

  if (description.length > MAX_LENGTH) {
    flags.push('length_exceeded');
  }

  if (facts.address && !addressMentioned(description, facts.address)) {
    flags.push('address_missing');
  }

  if (
    facts.lineItems.length > 0 &&
    !lineItemReferenced(description, facts.lineItems)
  ) {
    flags.push('line_item_missing');
  }

  if (hasUnsourcedFigures(description, facts)) {
    flags.push('hallucinated_facts_suspected');
  }

  return flags;
}

function addressMentioned(description: string, address: string): boolean {
  const lower = description.toLowerCase();
  const streetNumber = address.match(/\b\d{1,6}\b/)?.[0];
  if (streetNumber && lower.includes(streetNumber)) return true;
  const zip = address.match(/\b\d{5}\b/)?.[0];
  if (zip && lower.includes(zip)) return true;
  // Fallback: any 4+ char street-name token
  const tokens = address
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4);
  return tokens.some((t) => lower.includes(t));
}

function lineItemReferenced(description: string, lineItems: string[]): boolean {
  const lower = description.toLowerCase();
  return lineItems.some((item) => {
    const tokens = significantTokens(item);
    return tokens.some((t) => lower.includes(t));
  });
}

function significantTokens(text: string): string[] {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'from', 'will', 'this', 'that', 'into',
    'feet', 'foot', 'inch', 'inches', 'linear', 'per', 'each',
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));
}

const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?/g;

function hasUnsourcedFigures(
  description: string,
  facts: CollectedFacts,
): boolean {
  const sourceText = [
    facts.scopeSummary,
    facts.address ?? '',
    facts.accessNotes ?? '',
    facts.photosUrl ?? '',
    facts.durationLine ?? '',
    ...facts.lineItems,
  ]
    .join(' ')
    .toLowerCase();

  for (const re of [PHONE_RE, EMAIL_RE, MONEY_RE]) {
    re.lastIndex = 0;
    const matches = description.match(re) ?? [];
    for (const m of matches) {
      if (!sourceText.includes(m.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

// ── prompt building ──────────────────────────────────────────────────────

function buildPrompt(args: {
  facts: CollectedFacts;
  conversation: EventDescriptionMessage[];
  input: BuildEventDescriptionInput;
  previousAttempt: { description: string; flags: string[] } | null;
}): string {
  const { facts, conversation, previousAttempt } = args;

  const lineItemBlock = facts.lineItems.length
    ? facts.lineItems.map((l) => `- ${l}`).join('\n')
    : '(none provided)';

  const conversationBlock = conversation.length
    ? conversation
        .map((m) => `[${m.direction === 'incoming' ? 'customer' : 'matt'}] ${m.text.trim()}`)
        .join('\n')
    : '(no recent conversation)';

  const retryNote = previousAttempt
    ? `\n\nPRIOR ATTEMPT FAILED these checks: ${previousAttempt.flags.join(', ')}. Fix the issues — every fact you state must come from the facts block, and you MUST include the address (street number works) and reference at least one line item.\n\nPRIOR ATTEMPT TEXT (for reference, do not copy):\n${previousAttempt.description}\n`
    : '';

  return `You write Google Calendar event bodies for a foundation-repair business. Output ONLY the event body text — no markdown headers, no preamble, no code fences. Length under ${MAX_LENGTH} characters.

FACTS (use ONLY these — do not invent customer names, addresses, prices, phone numbers, or scope details that are not listed):
- Customer: ${facts.customerName}
- Address: ${facts.address ?? '(not on file)'}
- Event type: ${facts.eventClass} (${facts.intent})
- Scope summary: ${facts.scopeSummary || '(none)'}
- Line items:
${lineItemBlock}
- Photos URL: ${facts.photosUrl ?? '(none)'}
- Access notes (from customer): ${facts.accessNotes ?? '(none)'}
- Duration estimate: ${facts.durationLine ?? '(not estimated)'}

RECENT CONVERSATION (most recent last; use to extract access details, site quirks, dog/gate/parking notes, customer asks — do NOT fabricate quotes):
${conversationBlock}

FORMAT (plain text, blank lines between sections, no markdown):
Scope:
- <one bullet per line item or scope point>

Address:
<address verbatim from facts>

Access / site notes:
- <only items mentioned in the conversation or access notes — omit section if none>

Photos:
<URL from facts, or omit if none>

Duration estimate:
<duration line from facts, or omit if none>

REQUIREMENTS:
1. The address MUST appear in the output.
2. At least one line item MUST appear in the output.
3. Do NOT include phone numbers, email addresses, or dollar figures unless they appear verbatim in the facts.
4. Do NOT add salutations, signatures, "see you then", or any text outside the format above.${retryNote}`;
}

// ── fallback (deterministic, no LLM) ────────────────────────────────────

function buildFallbackDescription(input: BuildEventDescriptionInput): string {
  const facts = collectFacts(input);
  const parts: string[] = [];

  parts.push('Scope:');
  if (facts.lineItems.length > 0) {
    for (const item of facts.lineItems) parts.push(`- ${item}`);
  } else {
    parts.push(`- ${facts.scopeSummary || '(no scope on file)'}`);
  }

  parts.push('');
  parts.push('Address:');
  parts.push(facts.address ?? '(not on file)');

  if (facts.accessNotes) {
    parts.push('');
    parts.push('Access / site notes:');
    parts.push(`- ${facts.accessNotes}`);
  }

  if (facts.photosUrl) {
    parts.push('');
    parts.push('Photos:');
    parts.push(facts.photosUrl);
  }

  if (facts.durationLine) {
    parts.push('');
    parts.push('Duration estimate:');
    parts.push(facts.durationLine);
  }

  let out = parts.join('\n');
  if (out.length > MAX_LENGTH) out = out.slice(0, MAX_LENGTH).trimEnd() + '…';
  return out;
}
