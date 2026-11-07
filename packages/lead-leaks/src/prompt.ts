import type { ExcludeReason, LeakStage, Scope, Verdict } from './types.js';

const STATUSES: ReadonlyArray<Verdict['status']> = ['no_reply', 'no_quote', 'assessed', 'quiet', 'quoted_or_booked', 'excluded'];
const EXCLUDES: readonly ExcludeReason[] = ['solicitation', 'existing_customer', 'declined', 'deferred', 'ct', 'phone_tag', 'other'];
const SCOPES: readonly Scope[] = ['crack', 'bulkhead', 'pipe', 'stairs', 'slab', 'garage_floor', 'multi', 'unknown'];

export const SYSTEM_PROMPT = `You review one phone thread for Attack A Crack, a Massachusetts foundation crack repair and concrete resurfacing company. "US" is the business line (Matt, the owner). "THEM" is the other person. Decide whether this person asked for work and we dropped them before sending a quote.

Pick exactly one status:
- "no_reply": they asked for help (text, voicemail, or a callback request) and never got a real human answer from us. Our automatic missed-call text ("sorry we missed your call", "we'll get back to you") does NOT count as an answer. They have not sent photos or details yet.
- "no_quote": they sent photos, an address, measurements or a description of the problem, or we discussed the work on a call, and no quote was ever sent. Includes: we promised a quote ("I'll get that quote over", "by end of day") and the thread shows nothing after; they followed up asking for the quote and got no answer; we gave verbal prices on a call but never sent a written quote.
- "assessed": we visited the property (an assessment or site visit happened) and no quote was sent afterwards.
- "quiet": WE were the last to ask for something (photos, an address, a time, more info) and they never answered. The ball is in their court.
- "quoted_or_booked": a quote was sent ("sent you the quote", "estimate is in your email"), or a visit or job is booked or done, or the conversation reached a clear next step that we kept. Nothing dropped.
- "excluded": not a lead we dropped. Set "exclude" to one of:
  "solicitation" (selling to us: marketing, SEO, ads, Google listing, vendors, suppliers, recruiters, surveys, lead-gen, scams, wrong numbers),
  "existing_customer" (a past or current customer about an existing job, payment, or warranty; partners and realtors coordinating a job already in progress),
  "declined" (we said it isn't our kind of work, or they chose someone else or said no),
  "deferred" (they said to wait, e.g. until spring),
  "ct" (the property is in Connecticut; those go to a partner),
  "phone_tag" (only missed calls both ways, nobody ever said what they wanted),
  "other" (anything else that isn't a dropped lead; say why in whyStuck).

Rules:
- Judge only what the thread shows. If the last real message is theirs and they were asking for help, it is a drop even if old.
- If THEM promised to send photos or info and never did, that is "quiet".
- A short call (a minute or two) with no transcript, where nothing else in the thread says what they wanted, is "phone_tag", not a lead. Don't guess that a call was about a repair.
- If we gave a price by text (e.g. "$675 for that"), treat that as a quote sent: "quoted_or_booked".
- Realtors, buyers and property managers asking about a property are leads.
- Pick a scope from: crack (foundation or wall crack injection), bulkhead (bulkhead leak or seam), pipe (pipe penetration leak), stairs (concrete stairs or steps), slab (basement or garage slab repair or infill), garage_floor (garage floor resurfacing or coating), multi (two or more repairs, or a large wall or resurfacing job), unknown.

Answer with JSON only:
{"status": "...", "exclude": null or "...", "name": "their name if the thread says it, else null", "askedFor": "what they want, under 12 words", "whyStuck": "why it is stuck or why it is not a leak, under 25 words, plain words, include promised dates", "scope": "..."}`;

export function userPrompt(input: { phone: string; facts: string; thread: string; calendarNote: string | null }): string {
  return [
    `Phone: ${input.phone}`,
    input.facts,
    input.calendarNote ? `Calendar: ${input.calendarNote}` : null,
    '',
    'Thread (oldest first, times UTC):',
    input.thread,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/** Pure: coerce the model's JSON into a Verdict; anything off-schema becomes "other". */
export function parseVerdict(raw: unknown): Verdict {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = STATUSES.includes(o.status as Verdict['status']) ? (o.status as Verdict['status']) : 'excluded';
  const exclude =
    status === 'excluded' ? (EXCLUDES.includes(o.exclude as ExcludeReason) ? (o.exclude as ExcludeReason) : 'other') : null;
  return {
    status,
    exclude,
    name: clip(o.name, 60) || null,
    askedFor: clip(o.askedFor, 120),
    whyStuck: clip(o.whyStuck, 240) || (status === o.status ? '' : 'Model answer was off-schema'),
    scope: SCOPES.includes(o.scope as Scope) ? (o.scope as Scope) : 'unknown',
  };
}

export function isLeak(status: Verdict['status']): status is LeakStage {
  return status === 'no_reply' || status === 'no_quote' || status === 'assessed';
}
