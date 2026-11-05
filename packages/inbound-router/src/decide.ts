/**
 * decide(): which drafters run for a settled burst. Pure; the read judges
 * the customer, the thread state says what already happened.
 *
 * - CT property → CT routing (Luc handoff) on first touch, else nothing;
 *   CT is Luc's even when a can't-help rule (out of area) also fires.
 * - can't help → decline note only (naming a referral when one fits), on
 *   first touch or later, unless Matt has already answered. No intake
 *   note, no quote draft.
 * - need info → intake asks the one deciding question (first touch only;
 *   once Matt is talking to them it's his call). No quote draft.
 * - only thanks / sign-offs (every intent "other") → nothing.
 * - first touch = Matt hasn't engaged, no intake yet, and the burst is a new
 *   inquiry (new_lead or quote_request).
 * - can help → intake on first touch; quote drafter on photos (T1) or
 *   Matt's quote promise (T3); the scope-change gate (T4) instead when a
 *   quote is already open; scheduling on a scheduling reply.
 */
import type { InboundRead, Route, ThreadState } from './types.js';

export function decide(read: InboundRead, state: ThreadState): Route[] {
  if (read.classification !== 'lead') {
    return [{ route: 'none', why: `not a lead (${read.classification})` }];
  }

  // Thanks, sign-offs, reviews: nothing to answer, whatever the thread is about.
  if (read.intents.every((i) => i === 'other')) {
    return [{ route: 'none', why: 'nothing to act on (thanks / sign-off)' }];
  }

  // Intake greets a new inquiry; a past customer calling to cancel isn't one.
  const firstTouch =
    !state.mattEngaged &&
    !state.intakeDone &&
    (read.intents.includes('new_lead') || read.intents.includes('quote_request'));

  if (read.propertyState === 'CT') {
    return firstTouch
      ? [{ route: 'ct-routing', why: 'CT property, first touch' }]
      : [{ route: 'none', why: 'CT property, already in conversation' }];
  }

  if (read.canHelp.verdict === 'cant-help') {
    return state.mattRepliedLast
      ? [{ route: 'none', why: "can't help, Matt has already answered" }]
      : [{ route: 'decline', why: read.canHelp.reason || "on the can't-help list" }];
  }

  if (read.canHelp.verdict === 'need-info') {
    return firstTouch
      ? [{ route: 'intake', why: `one question first: ${read.canHelp.question ?? read.canHelp.reason}` }]
      : [{ route: 'none', why: 'need info, Matt is already talking to them' }];
  }

  const routes: Route[] = [];
  if (firstTouch) routes.push({ route: 'intake', why: 'new lead, no reply yet' });

  const quoteWhy = [
    state.newPhotos ? `T1 ${state.newPhotos} photo(s)` : '',
    state.quotePromised ? 'T3 quote promised' : '',
    read.intents.includes('scope_change') ? 'scope change' : '',
  ].filter(Boolean);
  if (state.openQuote && quoteWhy.length) {
    routes.push({ route: 'quote-gate', why: `T4 open quote: ${quoteWhy.join(', ')}` });
  } else if (state.newPhotos || state.quotePromised) {
    routes.push({ route: 'quote', why: quoteWhy.filter((w) => w !== 'scope change').join(', ') });
  }

  if (read.intents.includes('scheduling_reply')) {
    routes.push({ route: 'scheduling', why: 'scheduling reply (phase 5)' });
  }

  return routes.length ? routes : [{ route: 'none', why: 'nothing to draft' }];
}
