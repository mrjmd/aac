# @aac/stale-quotes — Stale-Quote Follow-Up

One scan of every QBO Pending quote: the gate chain, the cadence ladder
(T1 day 2-3 → T2 day 10-14 → T3 final, A/B variants), and for quotes whose
slot has arrived a Gemini-drafted, price-silent, schedule-honest SMS posted
as a `📋 STALE-QUOTE FOLLOW-UP` Quo contact note. Nothing is ever sent.

Plan: `analysis/02-strategy/stale-quote-followup-plan-2026-10.md`.

## Callers

- `apps/worker/api/stale-quotes.ts`: daily cron, Redis `stale-quotes:mode`
  (off | dry | live).
- `tools/src/stale-quotes/run.ts`: by hand (`--dry-run`, `--doc N`,
  `--max-drafts N`).
- `tools/src/triage` reads the saved queue and awaiting-reply list
  (`loadStaleQuoteLists`) for triage.html and the command center items.

## State (Redis, keys in `@aac/shared-utils/redis`)

- `stale-quotes:state` HASH estimate id → EstimateState (variant, suspends,
  extraction cache, touches). Live runs only; pruned when a quote leaves
  Pending. A run writes only the entries it changed, merged field by field
  over the saved entry (`mergeEstimate`): a field someone else changed
  since the run read it (an owner hand-set mid-run) keeps their value. A
  prune only deletes entries the run loaded.
- `stale-quotes:queue` the last live run's queue (to send, waiting, flags,
  skipped).
- `stale-quotes:awaiting` quotes where the customer spoke last; every full
  scan, dry or live.
- `stale-quotes:runlog` LIST, newest first, capped at 5000.

## Rules

- Calendar and Gmail are hard gates: no degraded mode.
- The extraction (intent, stated timing, needs-reply) is cached per quote by
  the last inbound timestamp; only live runs save it, so a dry run
  re-extracts every thread.
- Conversation gates are per customer (QBO customer id): SMS, calls and every
  email address / "Quote N" thread across all their Pending quotes are read
  once and suspend every one of them (Jill Fairweather, 11/06: an email on
  #1389's thread did not stop a T1 on #1587). A stated timing on one quote
  holds its siblings without being copied onto them, and is never replaced
  by an extraction of an inbound older than when it was recorded (owner
  hand-sets survive). The awaiting-reply list has one entry per customer.
  The cadence ladder (touch count, tier) stays per quote.
- One draft per customer per day (owner 11/06): every due quote of theirs,
  plus gate-passing siblings at least 2 days old that aren't due yet, goes
  into one text naming each by the work. Every quote records the touch at
  its own tier (`docs` lists them, lead first), so the ladders move
  together; the gentlest tier sets the tone (a "closing out" final touch
  only when all are on T3). It is one queue entry and one Quo note, and it
  counts once against the cap. While any of their drafts sits unsent, no new
  one is drafted for that customer.
- A run past `deadlineMs` stops starting new quotes, saves state, and keeps
  the last full queue and awaiting list (`partial: true`).
- The draft cap (`MAX_DRAFTS_PER_DAY`, 6) is per Eastern day: touches already
  queued today count, so a rerun (the worker's backstop slot, `--max-drafts`)
  only fills the rest. A touch is saved the moment it is drafted, and a
  same-day rerun re-lists it in `toSend` (earlier days: `waiting`), never
  re-drafts it. A `--doc` run ignores earlier drafts.
- `FEW_SHOTS` is frozen from `patterns.json` (2026-10-21); change it on
  purpose, not by recomputing.
