import type { GeminiClient } from '@aac/api-clients/gemini';
import type { ServiceClass } from './types.js';

// ── Gemini: intent + stated-timing extraction ────────────────────────

export interface Extraction {
  intent: 'declined' | 'went-elsewhere' | 'later' | 'engaged' | 'none';
  confidence: 'high' | 'medium' | 'low';
  /** Verbatim customer words supporting the intent (required for declines). */
  evidence: string | null;
  statedTiming: { resumeAt: string; evidence: string } | null;
  humanTopic: boolean; // price negotiation / complaint / payment chasing
  /** The customer's latest message asks or requests something Matt hasn't
   *  answered. A polite sign-off is false. */
  needsReply: boolean;
}

export function buildExtractionPrompt(input: {
  customer: string;
  quoteDate: string;
  items: string[];
  smsTail: string;
  emailTail: string;
  today: string;
}): string {
  return `You are analyzing a foundation-repair company's communication with a customer about an open quote.

Customer: ${input.customer}
Quote sent: ${input.quoteDate} for: ${input.items.join(', ')}
Today: ${input.today}

RECENT TEXT THREAD (newest last; "OUT" = us, "IN" = customer):
${input.smsTail || '(no text thread)'}

RECENT EMAIL FROM/TO CUSTOMER (newest last):
${input.emailTail || '(none)'}

Answer in strict JSON, nothing else:
{
  "intent": "declined" | "went-elsewhere" | "later" | "engaged" | "none",
  "confidence": "high" | "medium" | "low",
  "evidence": "<verbatim customer words supporting the intent>" | null,
  "statedTiming": { "resumeAt": "YYYY-MM-DD", "evidence": "<verbatim customer words>" } | null,
  "humanTopic": true | false,
  "needsReply": true | false
}

Rules:
- "declined"/"went-elsewhere" ONLY if the customer explicitly said so — quote their exact words in "evidence". No verbatim evidence → the intent cannot be "declined" or "went-elsewhere".
- A deferral is NOT a decline. "The buyer will fix it after closing", "we'll deal with it after we move in", "once the other project wraps" = "later" (they may well still use us) — unless they name another company or say no outright.
- "later" = customer stated a deferral ("not until spring", "after we close", "couple of weeks", "health issue, get back to you"). Convert their words to a concrete resumeAt date (be generous — if "couple of weeks", add ~2.5 weeks; if "spring", use next March 15; if "after closing" with no date, add ~6 weeks).
- "engaged" = active conversation that a bot should stay out of right now.
- "none" = nothing decision-relevant since the quote.
- humanTopic = true if there is active price negotiation, a complaint/callback, or unpaid-invoice chasing in the thread.
- statedTiming comes from CUSTOMER words only, never ours.
- needsReply looks ONLY at the customer's most recent message (text or email). true = it asks a question, requests something (a call, a date, a change, info), or raises a concern that we have not answered after it. false = a polite sign-off or acknowledgment that needs no answer ("thanks, I'll get back to you", "ok sounds good", "got it, will discuss with my wife", a thumbs up). When unsure, true.`;
}

export function parseExtraction(raw: string): Extraction | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Extraction;
    if (!j.intent) return null;
    // Older cached shapes / a model that drops the field: fail safe to "wait on Matt".
    if (typeof j.needsReply !== 'boolean') j.needsReply = true;
    return j;
  } catch {
    return null;
  }
}

export function parseExtractionLoose<T>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

// ── Gemini: draft generation + review ────────────────────────────────

export function buildDraftPrompt(input: {
  customer: string;
  firstName: string;
  quoteDate: string;
  ageDays: number;
  items: string[];
  tier: 'T1' | 'T2' | 'T3';
  seasonClass: ServiceClass;
  horizonText: string;
  smsTail: string;
  statedTiming?: string;
  fewShots: string[];
  today: string;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You write SMS follow-ups for Matt, owner of Attack A Crack (foundation crack repair, Massachusetts). You write EXACTLY as Matt writes: friendly, direct, zero corporate filler, first person singular. One SMS (aim for 300-450 characters). Never use em dashes excessively, never sign with a name (his texts are from his known number).

HARD RULES — violating any one makes the draft unusable:
1. NEVER mention price, cost, discounts, or that pricing may have changed — in any direction.
2. NEVER invent facts: no claimed conversations, visits, or promises that are not in the thread.
3. Schedule honesty: the ONLY availability claim allowed is the booking horizon provided. Never imply we can fit them in sooner, never manufacture urgency the calendar contradicts.
4. Call it a "quote", never an "estimate".
5. No "bad news / good news" framing. State things directly.
6. If a stated timing exists, respect it — reference their stated plan, don't pressure past it.
7. Refer to the existing quote ONLY in past/present tense ("the quote I sent over"). NEVER phrase anything as a promise to send or prepare a quote ("I'll get you a quote") — the quote already exists.

Here are real follow-up texts Matt has sent (voice reference):
${input.fewShots.map((s) => `- "${s}"`).join('\n')}`;

  const tierFlavor = {
    T1: 'First follow-up. Light touch: checking they saw the quote, offer to answer questions or hop on a call. If the booking horizon is long, mention it matter-of-factly as lead-time planning info (the honest "grab a spot" angle), not fake scarcity.',
    T2: 'Second follow-up (no reply to the first). Invite questions about the approach/scope; include the honest lead-time note. Acknowledge implicitly that life gets busy — zero guilt.',
    T3: 'Final follow-up. Matt\'s proven closer: it has been a while, before I close out the quote in my system I figured I\'d reach out one more time — still interested in getting it done? A real seasonal angle is welcome if one applies (frost/freeze-thaw for cracks in winter; spring list for exterior work). Make clear no reply = he\'ll close the file, no hard feelings.',
  }[input.tier];

  const userPrompt = `Customer: ${input.customer} (address them as ${input.firstName})
Quote sent: ${input.quoteDate} (${input.ageDays} days ago) for: ${input.items.join(', ')}
Service class: ${input.seasonClass}
Booking horizon (the only availability fact you may use): ${input.horizonText}
${input.statedTiming ? `Customer's stated timing: ${input.statedTiming}` : ''}
Touch tier: ${input.tier} — ${tierFlavor}
Today: ${input.today}

RECENT THREAD (newest last; OUT = Matt, IN = customer):
${input.smsTail || '(no prior text thread beyond the quote)'}

Write the single SMS follow-up now. Output ONLY the message text, no quotes, no preamble.`;

  return { systemPrompt, userPrompt };
}

export function buildReviewPrompt(
  draft: string,
  horizonText: string,
  tier: 'T1' | 'T2' | 'T3',
  quoteContext: string,
  smsTail: string,
): string {
  // Owner decision 2026-11-05: "I'll close out the quote/file if I don't hear back"
  // is true on the real final touch, so it's allowed there and nowhere else.
  const closeRule =
    tier === 'T3'
      ? '- (allowed: this IS the final touch, so saying he will close out the quote/file if he does not hear back is honest, not fake urgency)'
      : '- says or implies the quote/file will be closed out or deleted (only allowed on the final touch, and this is not it)';
  return `Review this outbound SMS draft for a foundation repair company. Answer in strict JSON: {"ok": true|false, "problems": ["..."]}.

The quote this follows up on: ${quoteContext}

The text thread with this customer (the drafter saw this too; details taken from it, like "garage", "bulkhead", a closing date or an insurance claim, are real, NOT invented):
${smsTail || '(no prior text thread beyond the quote)'}

Fail it if ANY of these appear:
${closeRule}
- refers to a property, town, or piece of work that is not the one in the quote above (mixing up two jobs)
- mentions price/cost/discount/"prices have changed" in any form
- invents a fact, conversation, or promise that appears in neither the quote nor the thread above
- claims availability other than: "${horizonText}" (paraphrase is fine, contradiction is not; implying a sooner slot or fake scarcity = fail)
- calls the quote an "estimate"
- longer than ~600 characters or contains multiple messages
- pressures a customer who stated a later timeline

DRAFT:
${draft}`;
}

export async function generateWithRetry(gemini: Pick<GeminiClient, 'generateContent'>, prompt: string, systemPrompt?: string): Promise<string> {
  return gemini.generateContent(prompt, {
    systemPrompt,
    temperature: 0,
    maxOutputTokens: 4096,
    thinkingBudget: 4096,
    timeoutMs: 120_000,
    retries: 2,
  });
}
