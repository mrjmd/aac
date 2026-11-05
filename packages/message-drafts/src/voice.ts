/**
 * Draft generators, quality gates, and canonical-skeleton fallbacks.
 *
 * Voice: few-shot generation from Matt's own 2026 sends (bundled
 * exemplars) + deterministic gates; a gate failure falls back to the
 * canonical skeleton rather than showing raw AI output.
 */
import { parseJsonText, type GeminiClient } from '@aac/api-clients/gemini';
import { LUC_LINE, EMAIL_RE } from './types.js';

export function pickExemplars<T>(all: T[], n: number, seed: number): T[] {
  // deterministic rotation so consecutive runs vary their few-shot set
  const out: T[] = [];
  if (!all.length) return out;
  for (let i = 0; i < Math.min(n, all.length); i++) out.push(all[(seed + i * 7) % all.length]);
  return out;
}

const VOICE_RULES = `You are drafting a text message AS Matt, owner of Attack A Crack (foundation crack repair, Massachusetts). Write EXACTLY as Matt writes — study the real examples provided. Hard rules:
- Never include any dollar amount, price, or discount.
- Never claim to have seen photos, visited, or spoken on the phone unless the context says so.
- Never state how far out we are booking (no "booking about a month out" style claims).
- Plain text only, no markdown, no em dashes (use commas or periods). Keep Matt's warmth but his brevity too.
- Output ONLY the message text, nothing else.`;

// ── post-quote follow-up ─────────────────────────────────────────

export async function draftFollowup(
  gemini: GeminiClient,
  args: { firstName: string | null; scopeLines: string[]; exemplars: Array<{ text: string }> },
): Promise<string | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's post-quote follow-up texts (for voice and shape — do not copy verbatim):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\n${e.text}`).join('\n')}

Now draft the follow-up text for THIS customer. Matt just emailed them their quote from QuickBooks.
Customer first name: ${args.firstName ?? '(unknown — use a greeting without a name)'}
What the quote covers (from the estimate's own line items — restate the scope in ONE natural sentence, in Matt's words, no prices):
${args.scopeLines.join('\n')}

Required elements: greet by first name (if known); say the quote was just sent to their email; one sentence restating what it covers; invite questions once they've had a chance to review; mention that once the quote is approved we can get them on the schedule for repair; a warm sign-off.`;
  try {
    const out = await gemini.generateContent(prompt, { maxOutputTokens: 4096 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function followupFallback(firstName: string | null, scopeSummary: string): string {
  const greet = firstName ? `Hey ${firstName}, ` : 'Hi there, ';
  return `${greet}I just sent that quote over to your email address. This is for ${scopeSummary}, and it does include our lifetime guarantee on the crack repair. Let me know if you have any questions once you've had a chance to review — as soon as the quote is approved, we can get you on the schedule for repair. Thanks, and I'll speak with you soon.`;
}

export function gateFollowup(draft: string): string | null {
  if (draft.length < 120 || draft.length > 900) return `length ${draft.length}`;
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (!/quote|estimate/i.test(draft)) return 'missing quote mention';
  if (!/email/i.test(draft)) return 'missing email mention';
  if (!/review|questions/i.test(draft)) return 'missing review/questions invite';
  return null;
}

// ── first-touch intake ───────────────────────────────────────────

export interface IntakeResult {
  classification: 'lead' | 'solicitation' | 'other';
  propertyState: 'MA' | 'CT' | 'other' | 'unknown';
  provided: { name: boolean; address: boolean; email: boolean };
  extracted: { name: string | null; address: string | null; email: string | null };
  /** From the photos + text against the owner's can't-help rules (2026-11-04). */
  verdict?: IntakeVerdict;
  verdictReason?: string;
  draft: string;
}

export type IntakeVerdict = 'can-help' | 'cant-help' | 'need-info';

export async function draftIntake(
  gemini: GeminiClient,
  args: {
    customerText: string;
    mediaCount: number;
    areaCode: string;
    exemplars: Array<{ customer: string; text: string }>;
    /** The customer's photos, so the reply reflects what they show (owner: photos gate every step). */
    imageParts?: Array<{ mimeType: string; base64: string }>;
    /** Owner's standing rules + referrals (CanHelpStore.block). */
    canHelpBlock?: string;
  },
): Promise<IntakeResult | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's first replies to new inquiries (customer message → Matt's reply):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\nCUSTOMER: ${e.customer}\nMATT: ${e.text}`).join('\n')}

A NEW inquiry just arrived on the business line. Analyze it, then draft Matt's first reply.

THE NEW INQUIRY (first message(s) from an unknown number):
${args.customerText || '(no text — photos only)'}
${args.mediaCount > 0 ? `[customer attached ${args.mediaCount} photo(s)${args.imageParts?.length ? `; ${args.imageParts.length} attached to this request, LOOK AT THEM` : ''}]` : '[no photos attached]'}
[texter's area code: ${args.areaCode || 'unknown'}]
${args.canHelpBlock ? `
${args.canHelpBlock}
` : ''}
Steps:
1. Classify: "lead" (homeowner/property contact with a real issue we might service), "solicitation" (lead-gen spam, vendor pitch, marketing), or "other" (wrong number, unclear).
2. Determine the PROPERTY's state: "MA", "CT", "other", or "unknown". Judge from town/city names and addresses in the message (e.g. Cromwell, Enfield, New Britain are CT; Quincy, Braintree, Weymouth are MA). The area code is only a weak hint (CT codes: 860/203/475/959) — people move, and an 860 number has texted about an MA property. Only answer "CT" when the message content supports it.
3. Note which of these the customer ALREADY provided, and extract the values: full name, property address, email address. Use null for anything not provided.
4. Verdict, from the text AND the photos, against the can't-help rules above (if given):
   - "cant-help": what they need is on the can't-help list (e.g. water coming through a cinder block wall or block bulkhead stairwell). Judge the material and whether it is actually leaking from the photos.
   - "need-info": it could go either way and ONE fact decides it (e.g. you can't tell whether the bulkhead walls are cinder block or poured concrete, or whether it is actually leaking).
   - "can-help": plausibly crack repair / concrete work we do.
   Put a one-sentence reason in verdictReason (what you saw that decided it).
5. If classification is "lead" AND the state is NOT "CT": draft Matt's reply, by verdict.
   - can-help: thank them / acknowledge what they sent specifically; confirm we can help; then ask ONLY for the items they have NOT already provided (full name, address of the property, email address for the quote). If they sent photos of a crack, mention the lifetime guarantee naturally. If they sent NO photos, ask for photos of the issue.
   - cant-help: kindly and briefly say this isn't something we're able to help with and why, in plain words (e.g. "because the walls are cinder block, which is hollow, our injection process can't stop the water"). If a referral fits, recommend them by name with their number. Do NOT ask for name, address, email, or more photos. Keep it short and warm.
   - need-info: thank them, then ask ONLY that one deciding question (and, if it helps, a photo from a few steps back). Do NOT ask for name, address or email yet.
   End every draft with Matt's signature line: "-- Matt at Attack A Crack".
6. If "solicitation" or "other", or the state IS "CT": draft must be an empty string (CT inquiries get a different reply drafted separately).

Return ONLY JSON: {"classification": "...", "propertyState": "...", "provided": {"name": bool, "address": bool, "email": bool}, "extracted": {"name": str|null, "address": str|null, "email": str|null}, "verdict": "can-help"|"cant-help"|"need-info", "verdictReason": "...", "draft": "..."}`;
  try {
    // Six photos + thinking runs past the 30s text default; the tick allows 300s.
    const out = await gemini.generateContent(prompt, {
      maxOutputTokens: 4096,
      imageParts: args.imageParts,
      ...(args.imageParts?.length ? { timeoutMs: 120_000 } : {}),
    });
    const parsed = parseJsonText<IntakeResult>(out);
    if (!parsed || typeof parsed.draft !== 'string') return null;
    parsed.propertyState ??= 'unknown';
    parsed.extracted ??= { name: null, address: null, email: null };
    if (parsed.verdict !== 'cant-help' && parsed.verdict !== 'need-info') parsed.verdict = 'can-help';
    return parsed;
  } catch {
    return null;
  }
}

export function gateIntake(
  draft: string,
  customerText: string,
  mediaCount: number,
  verdict: IntakeVerdict = 'can-help',
): string | null {
  if (draft.length < 80 || draft.length > 1100) return `length ${draft.length}`;
  if (verdict !== 'can-help' && /full name|address of the property|email address/i.test(draft)) {
    return `${verdict} draft asks for contact details`;
  }
  if (verdict === 'cant-help' && /definitely help|we can help/i.test(draft)) return "can't-help draft promises help";
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (/booking (about|around)|month out|weeks out/i.test(draft)) return 'lead-time claim';
  if (mediaCount === 0 && /thanks? for (sending|the) (photos|pictures)/i.test(draft)) return 'thanks for photos without photos';
  if (EMAIL_RE.test(customerText) && /email address where|an email address\b.{0,30}(quote|send)/i.test(draft) && !/that email|the email you/i.test(draft)) {
    return 'asks for email already provided';
  }
  return null;
}

export function intakeFallback(mediaCount: number, verdict: IntakeVerdict = 'can-help'): string {
  if (verdict === 'cant-help') {
    return `Hello, thanks for reaching out and for sending this over. Unfortunately, this isn't something we're able to help with, and I don't want to waste your time. I'm sorry I couldn't be more help, and best of luck getting it taken care of!\n\n-- Matt at Attack A Crack`;
  }
  if (verdict === 'need-info') {
    return `Hello, thanks for reaching out and for sending the photos! Before I put anything together, could you send one more photo taken from a few steps back so I can see the whole area? Thanks!\n\n-- Matt at Attack A Crack`;
  }
  const photoLine = mediaCount > 0
    ? 'Thanks for sending photos as well. '
    : 'Could you also send a few photos of the issue? ';
  return `Hello, thanks for reaching out! We can definitely help get this taken care of. ${photoLine}To get a quote together for you, I will just need the following information: your full name, the address of the property, and an email address where I can send the quote. Then, once I send that over, we can go over the details and any questions that you may have. Thanks!\n\n-- Matt at Attack A Crack`;
}

// ── CT→Luc routing ───────────────────────────────────────────────

export async function draftCtRouting(
  gemini: GeminiClient,
  args: { customerText: string; exemplars: Array<{ customer: string; text: string }> },
): Promise<string | null> {
  const prompt = `${VOICE_RULES}

REAL examples of Matt's replies to Connecticut inquiries that reached his Massachusetts line (customer message → Matt's reply):
${args.exemplars.map((e, i) => `--- example ${i + 1} ---\nCUSTOMER: ${e.customer}\nMATT: ${e.text}`).join('\n')}

A NEW Connecticut inquiry arrived on the Massachusetts business line:
${args.customerText || '(no text — photos only)'}

Draft Matt's reply. Required elements, in Matt's voice:
- Thank them / acknowledge what they sent specifically (greet by first name if they gave one).
- Let them know they've reached the Massachusetts office.
- Matt is FORWARDING their info and photos to his partner Luc, who runs the Connecticut office — do NOT ask the customer to re-send anything themselves.
- Luc will reach out; they should expect a text or call from ${LUC_LINE}.`;
  try {
    const out = await gemini.generateContent(prompt, { maxOutputTokens: 4096 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function gateCtRouting(draft: string): string | null {
  if (draft.length < 80 || draft.length > 900) return `length ${draft.length}`;
  if (/\$\s?\d/.test(draft)) return 'contains a price';
  if (!draft.includes(LUC_LINE)) return "missing Luc's number";
  if (!/luc/i.test(draft)) return 'missing Luc';
  if (!/massachusetts|ma office/i.test(draft)) return 'missing MA-office mention';
  if (!/forward|pass(ing)? (this |that |it |all |your )?(along|over|on)|send(ing)? (your|all|everything)/i.test(draft)) {
    return 'not forward-style';
  }
  return null;
}

export function ctRoutingFallback(firstName: string | null): string {
  const greet = firstName ? `Hi ${firstName}, thanks` : 'Hi there, thanks';
  return `${greet} for reaching out! You've actually reached the Massachusetts office. Not to worry though — I'm forwarding your info and the photos you sent over to my partner Luc, who runs our Connecticut office, and he will reach out. Keep an eye out for a text or call from him at ${LUC_LINE}. Thank you!\n\n-- Matt at Attack A Crack`;
}

/** The one-message handoff Matt sends Luc (off-platform). Format matches
 *  his real sends (owner screenshots, 2026-10-19): bare lines — name,
 *  address, email, phone, no labels — then the customer's own words quoted
 *  ("Here's what X sent:"). Photos get forwarded separately as images. */
export function buildLucHandoff(args: {
  phone: string;
  extracted: { name: string | null; address: string | null; email: string | null };
  customerText: string;
  mediaUrls: string[];
}): string {
  const lines = [
    args.extracted.name,
    args.extracted.address,
    args.extracted.email,
    args.phone,
  ].filter((l): l is string => !!l);
  const text = args.customerText.trim();
  if (text) {
    const who = args.extracted.name?.split(' ')[0] ?? 'they';
    lines.push(``, `Here's what ${who} sent: "${text.slice(0, 600)}"`);
  }
  if (args.mediaUrls.length) {
    lines.push(``, `${args.mediaUrls.length} photo(s) in the thread — forward those too. Links (may expire):`);
    lines.push(...args.mediaUrls.slice(0, 6));
  }
  return lines.join('\n');
}
