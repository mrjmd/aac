/**
 * buildEventDescription — turn a SchedulingDirective + customer facts +
 * Quo conversation history into the body text we'll write into the Google
 * Calendar event.
 *
 * The output is written in Matt's own calendar voice — a short, plain
 * note to Mike (second person), optionally led by a "NOTE:" line for
 * access/contact instructions. It deliberately does NOT contain the
 * address (that goes in the event's location field) and only mentions
 * photos when the caller is actually attaching some (photoCount).
 *
 * Pure function: LLM client + clock arrive via `deps`. The caller (the
 * middleware dispatch helper for Walk #6/7) is responsible for gathering
 * the input facts (PD customer, QB line items, recent Quo messages). This
 * function owns: prompt, LLM call, quality gates, retries, fallback.
 *
 * Quality gates per [[ai-quality-gates]]:
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
  /** Number of photos being attached to the event (0/absent = none). */
  photoCount?: number;
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
      previousAttempt: lastAttempt,
    });

    let raw: string;
    try {
      // gemini-3.6-flash counts internal reasoning against this budget —
      // 600 truncated bodies mid-sentence (same lesson as triage L1).
      raw = await deps.gemini.generateContent(prompt, {
        temperature: 0.2,
        maxOutputTokens: 4096,
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
  photoCount: number;
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
    photoCount: input.photoCount ?? 0,
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

/**
 * Real bodies Matt has written, verbatim (style reference in the prompt).
 * Kept short and varied: plain jobs, prior-visit, third-party payer,
 * NOTE: access lines, assessments, callbacks.
 */
const STYLE_EXAMPLES = [
  'Two cracks, one full length and one window.',
  'Single window crack, should be straightforward.',
  'You’ve been here, fieldstone injection and seal around a pipe penetration in a fieldstone foundation.',
  'Four cracks and some resurfacing at the floor. Christina Wichert is the realtor involved here.',
  'NOTE: text him when you’re 30 minutes out.\n\nWater coming in at the floor so we’ll assess as best we can, this may end up being a referral for exterior drainage work.',
  'Re-grind and seal / resurface patio crack, we’ve been out here several times.',
  'Bunch of tie rod leaks and possibly conduit penetration. We will need to update the quote when you get there so give me a call.',
];

function buildPrompt(args: {
  facts: CollectedFacts;
  conversation: EventDescriptionMessage[];
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

  const exampleBlock = STYLE_EXAMPLES.map((e) => `---\n${e}`).join('\n');

  const photoRule = facts.photoCount > 0
    ? `Photos from the customer are attached to this event — end the body with "See attached photos."`
    : 'No photos are attached — do not mention photos.';

  const retryNote = previousAttempt
    ? `\n\nPRIOR ATTEMPT FAILED these checks: ${previousAttempt.flags.join(', ')}. Fix the issues — every fact you state must come from the facts block, and when line items are provided the work described must clearly reference at least one of them.\n\nPRIOR ATTEMPT TEXT (for reference, do not copy):\n${previousAttempt.description}\n`
    : '';

  return `You are Matt, owner of Attack A Crack (foundation repair, Quincy MA), writing the body of a Google Calendar event for your technician Mike. "You" in the body means Mike; the customer is third person. Output ONLY the event body text — no markdown, no headers, no code fences, no greeting or sign-off.

REAL EXAMPLES OF MATT'S EVENT BODIES (match this voice exactly; never copy their facts):
${exampleBlock}
---

RULES:
1. One to four short sentences for straightforward work. Add a short extra paragraph only when there is a genuine wrinkle Mike needs to know about.
2. Lead with what the work is, in plain language (from the scope and line items).
3. If the conversation or access notes mention access/contact instructions (lockbox, gate code, call ahead, dog, parking, tenant), put them first on their own line starting "NOTE: ".
4. Do NOT include the address — it goes in the event's location field.
5. Do NOT include phone numbers, emails, or dollar amounts unless they appear verbatim in the facts below.
6. Only say "you've been here" / "we've been out here" if the facts or conversation clearly show a prior visit (callbacks qualify).
7. For an assessment, frame it as what to look at and figure out. For a callback, frame it as rework on something we previously repaired.
8. If the duration estimate says the job is unusually long (6+ hours or multi-day), mention that naturally; otherwise leave duration out.
9. ${photoRule}

FACTS (use ONLY these — do not invent scope details, names, or history that are not listed):
- Customer: ${facts.customerName}
- Event type: ${facts.eventClass} (${facts.intent})
- Scope summary: ${facts.scopeSummary || '(none)'}
- Line items:
${lineItemBlock}
- Access notes (from customer): ${facts.accessNotes ?? '(none)'}
- Duration estimate: ${facts.durationLine ?? '(not estimated)'}

RECENT CONVERSATION (most recent last; use for access details, site quirks, and context — do NOT fabricate beyond it):
${conversationBlock}${retryNote}`;
}

// ── fallback (deterministic, no LLM) ────────────────────────────────────

function buildFallbackDescription(input: BuildEventDescriptionInput): string {
  const facts = collectFacts(input);
  const parts: string[] = [];

  if (facts.accessNotes) {
    parts.push(`NOTE: ${facts.accessNotes}`);
    parts.push('');
  }

  parts.push(facts.scopeSummary || '(no scope on file)');

  if (facts.lineItems.length > 0) {
    parts.push('');
    for (const item of facts.lineItems) parts.push(`- ${item}`);
  }

  if (facts.durationLine) {
    parts.push('');
    parts.push(`Duration estimate: ${facts.durationLine}`);
  }

  if (facts.photoCount > 0) {
    parts.push('');
    parts.push('See attached photos.');
  }

  let out = parts.join('\n');
  if (out.length > MAX_LENGTH) out = out.slice(0, MAX_LENGTH).trimEnd() + '…';
  return out;
}
