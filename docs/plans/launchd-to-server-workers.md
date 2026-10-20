# Plan: Retire the Laptop — launchd Jobs → Server-Side Workers

**Date:** 2026-10-20 · **Status:** PROPOSED
**Driver:** Matt — "I don't like the idea of everything being dependent on
this laptop running launchd. That's not sustainable."

## Current inventory (everything on launchd)

| Job | Schedule | What it does | Trigger source |
|---|---|---|---|
| `com.aac.message-drafts` | every 60s (10-min sweeps) | Posts follow-up / intake / CT-routing draft notes to Quo | Fast path: drains `message-drafts:queue` (LPUSH'd by middleware `/api/qb-webhook` on quote EmailSent). Sweep: polls Quo conversations. |
| `com.aac.quote-shadow` | every 600s | Quote drafter: drains trigger events, settle window, Gemini draft → QBO Pending estimate + note | Drains `quote-trigger:queue` (LPUSH'd by middleware Quo webhook on T1 photo / T3 quote-promise). |
| `com.aac.triage` | daily 08:15 (+on-wake catch-up) | Builds snapshot.json (QBO/Quo/Calendar/Gmail), runs detectors D1–D14/L1/L2, renders triage.html, opens browser | Clock only. |

**Key fact:** the *triggers* are already webhooks. Middleware (Vercel,
always-on) sees every event and enqueues into Upstash Redis. The laptop is
only the worker + the clock. Failure mode today: laptop asleep/away = intake
drafts miss their 10-minute window, quote drafts stall, queues back up.

## Target architecture

- **Workers = plain Vercel serverless functions** (no framework — per
  standing decision) in a new small project `apps/worker`. Keeping them out
  of `apps/middleware` preserves the sacrosanct surface; same Upstash Redis,
  same env vars, same `@aac/*` packages.
- **Push instead of poll — Upstash QStash.** Where middleware today LPUSHes
  a Redis queue, it also publishes a QStash message to the worker URL with
  the natural delay built in:
  - intake draft: publish on first inbound, `delay=10m` (preemption window —
    worker re-validates "did Matt reply" at execution time, same as now)
  - follow-up draft: publish on qb-webhook EmailSent, no delay
  - quote drafter: publish on T1/T3, `delay=10–15m` (settle window), dedup
    by phone via existing `quote-trigger:lock`
  QStash gives retries + signature verification; the Redis queues stay as
  the audit trail/backstop.
- **Backstop cron:** one Vercel cron every 10 min hitting a sweep endpoint
  that runs the identical code path (catches anything QStash dropped). The
  laptop stops being a single point of failure; the cron is the safety net.
- **State out of the filesystem:** `state.json` (intakeDone/followupDone/
  noteAttempts) → Redis hashes. Drafter sync-token markers are already in
  Redis.
- **Assets out of the filesystem:**
  - message-pattern exemplars (small JSON) → commit to repo (private) —
    simplest, versioned
  - quoting ruleset (llm-ruleset.md), exemplar library, item library →
    repo or Vercel Blob
  - drafter's triage-snapshot customer join → already replaced by live
    lookups (2026-10-20 fix); remaining snapshot reads (recent estimates)
    become live QBO queries
- **Runtime limits:** drafter runs (photos + Gemini) can take 60–90s →
  `maxDuration: 300`; QStash's per-event fan-out means one customer per
  invocation, which fits.

## Phasing

**P1 — message-drafts worker** (highest value: time-sensitive, dies when
laptop sleeps). QStash wiring in middleware webhook + qb-webhook, worker
endpoints, state→Redis, exemplars→repo. Launchd job becomes a no-op and is
unloaded after a week of clean parallel running (worker posts, laptop
dry-runs, compare).

**P2 — quote drafter.** Same pattern; extra scope = asset migration, longer
runtime, and it WRITES QBO — keep the env kill-switch and ship behind a
shadow period like Phase 6 did.

**P3 — triage: keep local (recommended).** It's a morning dashboard that
opens a browser on this Mac; failure mode is a stale dashboard, not missed
customers. Optional later: cloud cron builds snapshot.json to Blob so other
workers/agents can consume it, laptop keeps only the render+open.

**Endgame:** launchd runs nothing but the triage browser-open (or nothing).

## Gotchas (from memory, so we don't re-learn them)

- New Vercel project defaults to SSO protection → QStash callbacks 401
  until disabled (bit us before with external webhooks).
- Verify QStash signatures on every worker endpoint (they're public URLs).
- Idempotency: reuse the existing NX markers (`markCronAction`-style) so a
  QStash retry + backstop-cron overlap can't double-post.
- Don't let worker code import from `apps/middleware` — shared logic moves
  to `packages/` first (DRY rule: migrate callers in the same change).
