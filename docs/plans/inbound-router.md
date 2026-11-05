# Inbound Router (design, not built)

Status: APPROVED 2026-11-05 (decisions at the bottom). Cleanup step 2.

## Problem

One new lead who sends a text and three photos today is read by three server
paths that don't talk to each other, plus two laptop jobs later:

| Path | When | Gemini calls | Writes |
|---|---|---|---|
| Quo webhook (`apps/middleware/api/webhooks/quo.ts`) | every event, entity extraction runs *before* the ack (:616) | 1 to 2 per text | Pipedrive, scheduling holds/stubs, suggestion note |
| Intake drafter (`packages/message-drafts`) | 10 min after the *first* inbound (`ZADD NX`, quo.ts:443) | 1 (+1 CT) | intake Quo note |
| Quote drafter (`packages/quote-drafter`) | 15 min after the *last* event (`ZADD GT`, trigger.ts:127) | 4 | QBO Pending estimate, created/declined Quo note |

Result: about 7 to 9 Gemini calls per lead, photos downloaded and read twice,
and up to three bot notes on one contact that can disagree (intake says "we
can help", quote drafter says "declined", or the reverse).

Decline rules live in two places that have already drifted:

- Intake reads the Redis store the command center `/referrals` page edits
  (`CanHelpStore`, `@aac/quoting/can-help.ts`) and names a referral.
- The quote drafter reads hard-coded prompt text plus `llm-ruleset.md` section 0
  rule 11 (`draft-quote.ts:140-146`) and only says "what kind of company" to call.
  A rule edited on `/referrals` never reaches it.
- `CanHelpStore` says empty means "code defaults", but the defaults only exist
  in `tools/src/can-help/seed.ts`.

Referrals have a store and a page, but nothing drafts a referral for anyone
past first touch (plan `can-help-and-referrals.md` step 4).

## Goal

1. **One read per settled burst.** Wait until the customer stops sending, read
   the conversation and photos once, classify once, save the read.
2. **One decline-rule source.** `CanHelpStore` (Redis, edited on `/referrals`,
   defaults in code) is the only place a can't-help rule lives. Every drafter
   gets the verdict from the read, not its own prompt.
3. **Referral is a route.** A can't-help verdict on any inbound (first touch or
   later) drafts a referral note. Never sends.
4. **One coherent set of notes.** The router decides which drafters run for a
   burst, so a declined lead never also gets a quote draft.

Non-goals: auto-sending anything; the agent line (`apps/agent`); the laptop
triage and stale-quote jobs (they can read the saved read later, step 3).

## Design

```
Quo webhook (middleware)          worker /api/inbound-tick (every min)
  ack in ms                         due phones -> claim lock
  record event  ─────────────────▶  load conversation + photos ONCE
  bump settle timer                 read(): one Gemini call, structured
  (PD sync, entity extraction       save inbound:read:{phone}
   move after the ack)              routes = decide(read, state)
                                      ├─ intake draft      (message-drafts)
                                      ├─ quote draft       (quote-drafter, reuses photo read)
                                      ├─ referral/decline  (new, CanHelpStore)
                                      ├─ scheduling        (phase 4)
                                      └─ nothing
```

### Settle timer

One zset, `inbound:due`, keyed by phone. Each customer event sets

`due = last + 2 min`, capped at `first + 10 min` (owner, 11/05: act as soon
as the burst calms down, no fixed wait).

- 2 minutes of quiet covers a burst of texts and photo MMS arriving back to
  back without drafting it halfway (today's intake bug).
- The cap stops a chatty thread from never settling.
- There is no longer a window for Matt to reply before a draft exists. Drafts
  are notes, never sent; if Matt has already replied when the burst settles,
  the read sees it and intake stands down as it does now.

### The read

`InboundRead` (saved at `inbound:read:{phone}`, 30-day TTL, with a fingerprint
of the newest message id so a re-run is a no-op):

- `entities`: name, address, email (replaces the webhook's synchronous
  `extractEntities`; Pipedrive still gets them, just after the burst).
- `intents`: new lead, quote request, photos sent, scope change on an open
  quote, scheduling reply (today's five scheduling kinds), question, other.
- `canHelp`: `can-help | cant-help | need-info`, the rule ids that fired, and
  the referral (from `CanHelpStore`).
- `photos`: per-media-id description and the area read the quote drafter
  already does; cached by media id so a later burst doesn't re-read old photos.

### Routes

`decide(read, state)` is a pure function (fully unit tested):

- `cant-help` → decline note only, naming who to call when a referral on
  `/referrals` fits, otherwise a straight decline. No intake note, no quote
  draft.
- `need-info` → intake note with the one clarifying question.
- new lead, `can-help` → intake note (as today).
- photos or Matt's quote promise (T1/T3) → quote drafter, handed the saved
  photo read instead of re-reading. Its own decline branch goes away.
- scope change on an open quote (T4) → quote drafter's gate, as today.
- scheduling reply → waits for the burst to settle like everything else, and
  no longer (phase 5; stays per message in the middleware until then).

### One decline source

- Move the seed defaults into `@aac/quoting` (`DEFAULT_CAN_HELP_RULES`,
  `DEFAULT_REFERRALS`) so "empty = code defaults" is true; the seed script
  imports them.
- Delete rule 11 from `llm-ruleset.md` section 0 and the hard-coded decline
  text in `draft-quote.ts`; the ruleset keeps pricing only.

## Rollout

Each phase is its own commit set and its own push, with your approval.

1. **Ack fast.** Move `extractEntities` and the Pipedrive sync in the Quo
   webhook after the response (`defer()`), so a slow Gemini call can never
   again get the webhook auto-disabled (10/19 incident). Same writes, later.
   Middleware: minimal, unit tested.
2. **One decline source.** Defaults into code, quote drafter reads
   `CanHelpStore`. This changes quote-drafter decline wording (it starts naming
   referrals), so you see before/after on recent real leads first.
3. **Router in shadow.** Webhook records events and the settle timer; the
   worker reads and decides, and logs what it *would* do next to what the old
   paths did. Old paths unchanged. Run a week; compare in the command center.
4. **Cut over intake, quote drafter and referrals** to the router, behind
   flags (`INBOUND_ROUTER_INTAKE`, `..._QUOTE`, `..._REFERRAL`), one at a time.
   Remove the intake sweep and `quote-trigger:*` keys once each is live.
5. **Scheduling** (after cleanup step 4 moves stub/hold dispatch into
   `@aac/scheduling`).

Expected end state: about 3 Gemini calls per lead (read, intake draft, quote
draft), photos read once, one note set per burst.

## Owner decisions (2026-11-05)

1. **Settle timing:** act as soon as the burst calms down. 2 minutes of quiet,
   capped at 10 minutes from the first message.
2. **Scheduling replies:** wait for the customer to finish, then act, no
   longer.
3. **Declines:** name who to call whenever a referral fits, otherwise a
   straight decline. Applies to the quote drafter too (phase 2).
4. Plan approved; build phase by phase, each push approved.
