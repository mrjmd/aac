# Plan: Retire the Laptop — launchd Jobs → Server-Side Workers

**Date:** 2026-10-20 · **Updated:** 2026-10-21 · **Status:** P0 + P1 SHIPPED 2026-10-21 (see Implementation notes); P2 (quote drafter) pending; P3 (triage) stays local
**Driver:** Matt — "I don't like the idea of everything being dependent on
this laptop running launchd. That's not sustainable." And 10/21: "When I send
a quote in QuickBooks, the very next thing I do is switch back over to Quo
and the follow-up text. This needs to be drafted for me almost instantly."

## Field evidence — the Vinay Kalyani miss (2026-10-21)

Quote #1564 emailed 8:54:42 AM; Matt switched to Quo within seconds; no
draft note. The note landed at 8:56:33 — the 10-min sweep got lucky. Forensics:

- **8:54:02** — Intuit delivered an `estimate.update` CloudEvent (~2s after
  Matt's save in QBO — Intuit delivery is FAST). Middleware fetched the
  estimate, but `EmailStatus` was not yet `EmailSent` (QBO recorded
  DeliveryTime 8:54:42, forty seconds later) → fast-path enqueue skipped.
- **Never** — no second QB webhook arrived (checked 10+ min later; day count
  stayed at 1). Intuit has a distinct **Emailed operation**
  (`estimate.emailed` event type) separate from Update. Our webhook
  subscription doesn't include it, and `isEstimateUpdate()` in
  `qb-webhook.ts` would ignore it even if it arrived.
- **8:56:22** — laptop sweep (10-min QBO poll) found EmailSent and drafted.

**Root cause: the one event that means "quote email went out" is the one
event we're not subscribed to.** The fast lane as built can only win when
the update event happens to arrive after QBO finishes dispatching the email
— i.e., rarely. Everything else (laptop, polling) compounded on top.

## Detection gaps — what's not using webhooks properly

| Signal | How we detect it today | The webhook that exists for it | Fix |
|---|---|---|---|
| Quote email sent | QBO poll every 10 min (sweep); update-event race rarely wins | `estimate.emailed` CloudEvent — **not subscribed, not handled** | Subscribe in Intuit dashboard + handle in qb-webhook → enqueue/publish |
| New inbound text (intake ask) | Quo conversations poll every 10 min, so the 10-min product window becomes 10–20 min | Quo message webhook — middleware already receives it | On first inbound, publish QStash `delay=10m`; window becomes exactly 10 min |
| Voicemail-only lead | Same 10-min sweep probing calls for transcripts | Quo call events — middleware already receives them | Same push model (transcript may lag — worker retries) |
| Quote trigger (T1 photos / T3 promise) | Webhook enqueues ✓, but laptop drains every 10 min | Already webhook-fed | QStash `delay=settle window` → worker (P2) |
| Scheduling dispatch | Runs INLINE in the Quo webhook (13s Gemini calls inside the ack path — the 10/19 auto-disable incident) | n/a — it IS the webhook | Move to fast-lane worker; webhook acks in ms (P1) |

Middleware's five Vercel crons (invoice-create 11:00, job-reminders 12:00,
job-followups 13:00, deal-reconcile 14:00, qb-reconcile 15:00 UTC) are
already cloud-side daily product windows — no change.

## Quote-follow-up latency budget (after P1 + emailed subscription)

T+0 = Matt clicks Send in QBO.

| Step | Cost | Notes |
|---|---|---|
| QBO dispatches the email | ~0–40s | QBO-internal; observed 40s on #1564 (may partly be edit-save → send-click gap). Out of our control. |
| `estimate.emailed` → middleware | ~2–5s | Intuit delivered today's update event in 2s |
| QStash publish → worker invoke | ~1–2s | |
| Gemini draft + Quo note | ~5–20s | Pre-generate the draft at the *update* event (T+2s, parallel with QBO's email dispatch), cache in Redis, post-only on emailed → this step drops to ~2s |
| **Total** | **~45–60s** (≈10s of it ours) | vs. 0–10 min today |

**Stretch option — beat QBO's own dispatch (~10–15s total):** trigger on the
update event itself when EmailStatus flips to send-intent. The deliverable is
a draft NOTE (never auto-sent), so a false positive costs one stray note.
Blocked on data: we don't log EmailStatus at event time. P1 adds that logging;
if send-intent proves reliable after ~a week of events, flip the trigger.

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

## Latency tiers (Matt, 2026-10-20: "if we move it to the cloud it needs to
## be happening quickly")

The 10-minute delays Matt sees today come from two different places and only
one of them should survive the migration:

1. **Polling artifacts** — the laptop drains queues every 60s/600s. These
   disappear entirely: webhook → QStash publish (~100ms) → worker invoke
   (~1s) → Gemini draft (5–20s). Wall clock from the triggering event to the
   note in Quo: **~10–30 seconds**.
2. **Product windows** — delays that encode a decision, kept on purpose:
   the 10-min intake preemption window exists so the system stays silent
   when Matt has already answered a new lead himself; the quote-drafter
   settle window exists because customers trickle photos in over several
   minutes and drafting early means drafting wrong.

| Flow | Tier | Target latency |
|---|---|---|
| Quote EmailSent → "I just sent that quote" follow-up draft | fast lane | seconds (no delay param) |
| quote_approved / scheduling reply → suggested-slot note + hold | fast lane | seconds |
| Stub/hold creation from confirmed slots | fast lane | seconds |
| First-touch intake ask / CT routing | windowed | 10 min (preemption — it's a backstop for when Matt is away; at his desk he's already replied and it correctly stays silent) |
| Quote drafter (T1 photos / T3 promise) | windowed | 10–15 min settle; option later: draft at +2 min and regenerate-in-place as photos land (drafter already supports regeneration) — costs more Gemini + note churn |

**Why execution doesn't run inline in the webhook function itself** (the
rationale for ack-then-work): the 2026-10-19 incident — ONE slow
scheduling-reply handler exceeded Quo's webhook timeout, Quo retried, timed
out again, and **auto-disabled the entire webhook**, silently killing every
downstream automation until it was manually re-enabled. Webhook handlers
must ack in milliseconds; anything that calls Gemini/QBO/Calendar belongs in
a worker invocation that can take 60s without endangering the event feed.
Today the scheduling dispatch still runs inline (that's why Michelle's
classification took 13s inside the webhook) — P1 moves it to the fast-lane
worker, which closes the ack-fast hardening item from the incident while
keeping seconds-level latency.

## Phasing

**P0 — the emailed event (do first, tiny, independent of the migration).**
(a) Enable the **Emailed** operation for Estimate on the webhook subscription
at developer.intuit.com; (b) qb-webhook: match `estimate.emailed` in addition
to update, enqueue on it, and log EmailStatus on every event (instruments the
send-intent stretch option). With just P0, the existing laptop 60s tick gets
the note posted in **under ~90s** of the send — the 10-minute worst case dies
immediately. Unit-tested, minimal diff (middleware is sacrosanct).

**P1 — fast lane + message-drafts worker** (highest value: time-sensitive,
dies when laptop sleeps). QStash wiring in middleware webhook + qb-webhook,
worker endpoints, state→Redis, exemplars→repo. Includes moving the inline
scheduling dispatch out of the Quo webhook into the fast-lane worker
(ack-fast hardening from the 10/19 incident) with seconds-level latency.
Launchd job becomes a no-op and is unloaded after a week of clean parallel
running (worker posts, laptop dry-runs, compare).

**P2 — quote drafter.** Same pattern; extra scope = asset migration, longer
runtime, and it WRITES QBO — keep the env kill-switch and ship behind a
shadow period like Phase 6 did.

**P3 — triage: keep local (recommended).** It's a morning dashboard that
opens a browser on this Mac; failure mode is a stale dashboard, not missed
customers. Optional later: cloud cron builds snapshot.json to Blob so other
workers/agents can consume it, laptop keeps only the render+open.

**Endgame:** launchd runs nothing but the triage browser-open (or nothing).

## Implementation notes (P1 as shipped, 2026-10-21)

**Deviation from the proposal: no QStash.** Same latency targets, zero new
external services/secrets/consoles, using infrastructure we already run:

- **Fast lane** = middleware → worker direct HTTPS (`x-worker-secret`).
  The worker's `draft-followup` acks **202 in milliseconds** and drafts
  via `waitUntil`, so the qb-webhook only pays one round-trip.
- **Intake 10-min window** = Redis ZSET delay queue
  (`message-drafts:intake-due`, ZADD NX on first inbound text/unanswered
  call) drained by the worker's **per-minute cron tick** — window fires at
  10–11 min instead of QStash-exact 10:00. Burst texts don't reset it.
- **Retries** = the Redis LIST/ZSET queues + the 10-min sweep cron + the
  laptop backstop, all re-validating through shared Redis HSETNX claims
  (`message-drafts:followup-done` / `intake-done`) — nothing double-posts,
  nothing is lost if any single actor dies.
- **Ack-fast dispatch** = `defer()`/`waitUntil` inside the Quo webhook
  (maxDuration 300) rather than a cross-app move — the dispatch logic
  stays in middleware lib, zero relocation risk.

Pieces: `packages/message-drafts` (all logic, exemplars bundled as code),
`apps/worker` (Vercel project `aac-worker-monorepo`: tick */1, sweep
*/10, draft-followup, health; CRON_SECRET + WORKER_SHARED_SECRET), the
laptop runner is now a thin backstop over the same package + Redis state
(state.json migrated). Verified live: tick heartbeat, sync fast-lane call
(noop on done estimate), manual sweep.

**Parallel run:** laptop launchd stays loaded as backstop. After ~a week
of the worker drafting everything first (laptop records shows only claims
lost to the worker), unload `com.aac.message-drafts`.

## Gotchas (from memory, so we don't re-learn them)

- New Vercel project defaults to SSO protection → QStash callbacks 401
  until disabled (bit us before with external webhooks).
- Verify QStash signatures on every worker endpoint (they're public URLs).
- Idempotency: reuse the existing NX markers (`markCronAction`-style) so a
  QStash retry + backstop-cron overlap can't double-post.
- Don't let worker code import from `apps/middleware` — shared logic moves
  to `packages/` first (DRY rule: migrate callers in the same change).
