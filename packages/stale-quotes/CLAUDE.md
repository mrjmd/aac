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
  Pending.
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
- A run past `deadlineMs` stops starting new quotes, saves state, and keeps
  the last full queue and awaiting list (`partial: true`).
- `FEW_SHOTS` is frozen from `patterns.json` (2026-10-21); change it on
  purpose, not by recomputing.
