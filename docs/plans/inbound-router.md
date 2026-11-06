# Inbound Router

Status: APPROVED 2026-11-05 (decisions at the bottom). Cleanup step 2.
Phases 1-2 live 2026-11-05; phase 3 built in `packages/inbound-router`, shipping off (tuned by replay).

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

- The quote drafter reads `CanHelpStore.block()` into its prompt (done in
  phase 2), so a rule edited on `/referrals` reaches both drafters.
- No code-default fallback: the store is seeded and edited on `/referrals`,
  and a fallback would resurrect rules the owner deleted. The Redis key
  comments now say so.
- `llm-ruleset.md` rule 11 keeps its guardrails (bowing over 1 inch, drainage
  first, fieldstone needs a site visit); they agree with the store. Folding
  them into the store happens with the router's read (phase 4).

## Rollout

Each phase is its own commit set and its own push, with your approval.

1. **Ack fast.** Move `extractEntities` and the Pipedrive sync in the Quo
   webhook after the response (`defer()`), so a slow Gemini call can never
   again get the webhook auto-disabled (10/19 incident). Same writes, later.
   Middleware: minimal, unit tested.
2. **One decline source.** Quote drafter reads `CanHelpStore`. This changes quote-drafter decline wording (it starts naming
   referrals), so you see before/after on recent real leads first.
3. **Router in shadow.** Webhook records events and the settle timer; the
   worker reads and decides, and logs what it *would* do next to what the old
   paths did. Old paths unchanged. Run a week; compare in the command center.
   Built: settle clock armed on the same events as intake (inbound texts,
   missed calls); a burst with no customer words waits for the voicemail
   (15-min grace) or is skipped; CT goes to Luc even when the out-of-area rule
   fires; can't-help stands down when Matt has already answered. Known gap
   until phase 4: Matt's own quote promise only counts when it lands inside a
   customer burst (outbound texts don't arm the clock); a failed read is
   logged, not retried.
   Decision 11/05: no week of shadow in production (it would add a Gemini call
   per burst on top of the old paths). The tick ships OFF (it only clears
   settled bursts so the clock stays fresh); the router is tuned by replaying
   ~100 past leads at burst time and fixing what's wrong, then phase 4.
   `inbound-router:mode` = `shadow` remains for a spot check.
4. **Cut over intake, quote drafter and referrals** to the router, behind
   flags (`INBOUND_ROUTER_INTAKE`, `..._QUOTE`, `..._REFERRAL`), one at a time.
   Remove the intake sweep and `quote-trigger:*` keys once each is live.
   Built (intake): the flag is Redis `inbound-router:live` (comma list, no
   redeploy to flip). With `intake` live the router posts the intake, CT
   routing and first-reply decline notes via message-drafts
   `processRoutedIntake`: one draft-only call from the read's verdict and photo
   descriptions, same note kinds, gates, fallbacks and state. The worker
   clears the old intake queue; the 10-min sweep re-arms the router for any
   customer message newer than its saved read (also retries failed reads).
   Drafts land about 2 min after the burst settles instead of the old 10-min
   preemption window.
   Built (quote): with `quote` live the router hands each quote or
   quote-gate route to the quote loop as a routed job (`quote-trigger:routed`,
   due now): T1 photos, T3 Matt's promise inside the burst, T4 a scope change
   on an open quote, judged by the read instead of the gate call. The quote
   tick drafts it under its run lock, modes (including T4 shadow), ownership
   and dedupe rules, and drops the customer's texts, photos and voicemails at
   drain time. It still triggers on what the router can't see: Matt's
   outbound promises, emails, call transcripts, Mike's debriefs. A declined
   or need-info burst no longer gets a quote draft. The drafter still reads
   the photos itself (its area pre-pass grounds prices in past quotes; the
   router's one-line photo descriptions don't replace it), so this step
   saves the T4 gate call, not the photo read.
   Built (referral): with `referral` live a decline once Matt is already
   talking to them (the customer adds work on the can't-help list
   mid-thread) goes to message-drafts `processRoutedReferral`: one draft-only
   call that reads the last 16 lines of the thread, continues it (no
   greeting), declines only the part we don't do and names the first
   referral; gated (names the referral, no contact ask, no price) with a
   skeleton fallback. One note per phone per 24 h
   (`message-drafts:referral-done`). A first-reply decline stays intake's.
   Nothing drafted these before (the old quote trigger's decline note only
   fired when photos or a promise ran a quote), so no old path turns off.
   Replay: 1 mid-thread decline in ~67 leads (a sunken slab after Matt asked
   for photos → Ram Jack); thanks-only bursts after Matt's own decline route
   to nothing. The command center's Referrals page lists every decline and
   referral note from the drafts runlog.
5. **Scheduling** (after cleanup step 4 moves stub/hold dispatch into
   `@aac/scheduling`). Status 2026-11-06: NOT STARTED; whether to start
   now is the owner's open call. The
   prerequisite is done (dispatch lives in `@aac/scheduling`), and the
   webhook already runs scheduling dispatch after the ack, so the 10/19
   timeout risk is closed without this phase. What it would add: act once
   per settled burst instead of per message. First step when picked up: a
   read-only replay of recent scheduling replies to count how often a
   burst actually produced a wrong or duplicate hold/stub.

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
