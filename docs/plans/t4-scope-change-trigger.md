# Plan: T4 — Scope-Change Detection on Open Quotes

**Date:** 2026-10-29 · **Status:** BUILT 2026-10-29 — all three phases (texts, calls, email) in one pass; T4 staged via `quote-drafter:t4-mode` (DEFAULT SHADOW, independent of the live global mode — flip with `mode.ts t4 live`). Index maintenance landed in the quote-drafter package + worker tick (30-min self-gate) instead of middleware's qb-reconcile; middleware got only the two webhook enqueue branches. Email channel pending a gmail.readonly check on the worker's Google token.
**Driver:** Matt, after the Kshitij Bichave miss (10/28): "We know that there
will be communications coming in to change the scope, and those could be
voicemails, call transcripts, texts, or emails."

## Field evidence — the Kshitij Bichave miss (2026-10-28)

- **11:26** — T1 fired on 2 inbound photo messages → created Pending
  estimate #1576 (\$1,325).
- **11:50, 12:21** — two more inbound bursts arrived: the exchange where it
  came out that the basement is **finished** (drywall removal required).
  Both classified `none` in `classify()` and were consumed and discarded.
- #1576 is also now human-owned (QBO SyncToken 1 vs stored 0), so even a
  T1/T3 re-fire could never have regenerated it under the one-way-door rule.

**Root cause: the only re-triggers are inbound photos (T1) and Matt's own
outbound quote-promise language (T3). Plain inbound information — exactly
the channel scope changes arrive on — has no trigger at all.** The
regeneration machinery itself already exists (`draftOne` regenerates a
bot-owned Pending draft in place when `hasNewInbound` is true, and re-reads
the full Quo thread, so it would have seen the drywall discussion).

## What T4 is

> **T4: inbound communication (text, voicemail, call transcript, email)
> from a customer with an open quote, whose content an LLM gate judges
> scope- or price-relevant.**

Two actions, split on ownership:

| Quote state | Action |
|---|---|
| Bot-owned Pending draft | Regenerate in place (existing `updateTarget` path, diff note via `buildDraftUpdatedNote`) |
| Human-owned Pending (edited, or manually created) | Never touch the estimate. Post a 🤖 Quo note ("New info may affect quote #1576 (\$1,325): basement is finished, drywall removal likely — review") + push a triage flag |

The one-way door stands: T4 never writes to a human-owned estimate.
Nothing here is ever customer-facing.

## Design

### 1. Open-quote index (Redis)

New key `quote-draft:open` — hash `phone → {estimateId, docNumber,
customerId, email, total, linesSummary, botOwned, updatedAt}`.

- **Written instantly** by the drafter at create/regenerate (it has all the
  fields in hand).
- **Maintained** by middleware's existing `qb-reconcile` cron (every 30
  min, already polls estimates): adds Pending estimates the bot didn't
  create (so T4 covers ALL open quotes, not just bot drafts), removes
  estimates that left Pending, refreshes `botOwned` from the stored
  SyncToken.
- **Verified live** before any write: `draftOne` already re-checks QBO
  ownership, so a stale index entry costs one skipped job, never a bad write.

This makes the T4 pre-check one HGET per settled phone, and gives the email
channel its reverse map (match inbound sender against `email` across the
hash — open quotes number a couple dozen at most).

### 2. Classification (quote-drafter package)

`runTick` today: `classify(events)` returns T1/T3 or null; null events are
discarded. Change: when classify returns null (and also alongside a T1/T3
skip-by-recency), if the phone is in `quote-draft:open` and the settled
events contain inbound content, run the **T4 gate**:

- Assemble the new content: event snippets, plus fetched transcript/
  voicemail text for call events (below), plus the last ~10 Quo thread
  messages for context (one `listMessages` call).
- One `gemini-3.6-flash` call (new `gate.ts` in `@aac/quote-drafter`):
  input = existing quote lines + total + the new content; output JSON
  `{scopeRelevant, reason, summary}`. Lean toward **recall** — a false
  positive costs one regeneration or one stray note; a false negative is
  the Bichave miss.
- On yes: enqueue a draft job `{trigger: 'T4', hasNewInbound: true}` for
  bot-owned, or post the note + flag for human-owned.
- Dedupe: `quote-drafter:t4-done` hash `estimateId → ISO`, 24h window
  (same pattern as T2), so a thread of five texts about drywall produces
  one regeneration, not five.

Runlog entries get `trigger: 'T4'` with the gate verdict + reason; the
triage D15 worker-drafts section renders them with no changes.

### 3. Channels

| Channel | Ingestion | New work |
|---|---|---|
| **Text** | Already enqueued by middleware (`message.received`) — today classified `none` and dropped | None upstream; T4 gate consumes what already flows |
| **Call transcript** | `call.transcript.completed` already passes the middleware event filter but is only enqueued for Mike (T2) | Middleware: also enqueue for non-internal numbers, `kind: 'call-transcript'` + `callId`. Runner fetches `quo.getCallTranscript(callId)` at gate time |
| **Voicemail** | `call.completed` incoming with no `answeredAt`/zero duration already detected (intake path) | Middleware: enqueue `kind: 'voicemail'` + `callId` on that same condition. Runner fetches `quo.getCallVoicemail(callId)`; transcription can lag, so if status isn't `completed`, re-arm the phone's due-clock +10 min (max 2 retries) |
| **Email** | No webhook. Poll. | New worker endpoint `api/quote-email-tick` (Vercel cron, every 15 min): Gmail `newer_than:2d` inbound, match sender against open-quote emails, dedupe by Gmail message id (Redis set), enqueue a synthetic trigger event (`kind: 'email'`, phone from the index, snippet = subject + body excerpt) into the normal queue |

`TriggerEvent` grows `kind: 'message' | 'mike-debrief' | 'call-transcript'
| 'voicemail' | 'email'` and optional `callId`. The middleware changes are
two fire-safe enqueue-only branches in `api/webhooks/quo.ts` (sacrosanct:
minimal, unit tested, never affects webhook processing).

**Email prerequisite:** the worker's `GOOGLE_REFRESH_TOKEN` must carry
`gmail.readonly`. Scopes freeze at mint (10/01 lesson) — probe first; if
absent, reauth via `tools/src/scratch/reauth-google.ts` and update the
worker env. Degrade gracefully: no scope → email channel disabled, log once.

### 4. Human-owned flag surface

- 🤖 Quo note on the customer's contact (existing `postDraftNote` path,
  new `buildScopeFlagNote` in `@aac/quoting`): quote #, total, the gate's
  one-line reason.
- Redis list `quote-drafter:scope-flags` → new triage section "Scope
  changes on open quotes" (reads the list like D15 reads the runlog, with
  the solicitations-style check-off).
- No proactive pings to Matt (per standing preference); triage + Quo note
  are the surfaces.

## Rollout

Respects the existing `off | shadow | live` mode. **Shadow first:** gate
runs and logs verdicts, regenerations are dry-run, notes/flags prefixed
`[shadow]` into the runlog only. Watch 3–5 days of verdicts in triage D15
(gate precision is the only real unknown), then flip live. The kill switch
is the existing `quote-drafter:mode` override.

## Phases

1. **P1 — texts** (the Bichave case, zero new ingestion): open-quote index
   (drafter write + qb-reconcile maintenance), T4 classify + gate,
   regenerate/flag actions, t4-done dedupe, runlog, triage section, tests.
   ~1 day.
2. **P2 — calls:** middleware enqueue branches (transcript + voicemail),
   fetch-by-callId in the gate, lag retry. ~half day.
3. **P3 — email:** scope probe/reauth, `quote-email-tick` cron, sender
   matching, message-id dedupe. ~half to 1 day.

## Decisions taken (flag if wrong)

- **Pending estimates only.** Scope changes after acceptance are a change-
  order workflow, not a quote regeneration — out of scope for v1.
- **All open quotes, not just bot drafts** (via qb-reconcile index
  maintenance). Matt cares about "the quote," not "the bot's quote";
  human-owned ones get the flag path.
- **Gate tuned for recall.** False-positive cost is one extra note or one
  regeneration of a bot draft nobody has touched; false-negative cost is a
  wrong quote going out.

## Packages/pillars touched

`packages/quote-drafter` (gate, classify, index writes),
`packages/shared-utils` (keys), `packages/quoting` (note builder),
`apps/middleware` (two enqueue branches + qb-reconcile index maintenance —
minimal, tested), `apps/worker` (email tick endpoint + cron),
`tools/src/triage` (scope-flags section).
