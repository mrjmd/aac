# Triage → cloud worker (cleanup step 3b)

Status: BUILT, not live (2026-11-05). Follows 3a (stale quotes in
`@aac/stale-quotes`). `packages/triage`, `TriageStore`, the Quo transcript
and voicemail methods, the thin CLIs, `seed-store.ts`, `dismiss.ts` and
`apps/worker/api/triage.ts` (cron 13:05 UTC, `triage:mode` unset = off) are
built and tested. Not done: seeding the store in prod, the worker `dry` run,
flipping to `live`, unloading `com.aac.triage`. Local worker dry run
(real APIs, no prod writes) took 863s (collect 104s, analyze 758s), over
the route's 720s budget and the 800s ceiling; the laptop's last two weeks
ran 550-680s. Decision 2's verdict cache likely has to ship before `live`.

## Goal

The command center's triage items come from a daily worker cron instead
of the laptop's 8:15 launchd run. triage.html stays runnable by hand
(`tools/src/triage/refresh.sh`) for spot checks, but nothing runs it on
a schedule. `com.aac.triage` is unloaded the day this ships, not before.

## What runs today (laptop, ~8 min)

`refresh.sh`: collect.ts → quote-trigger/harvest-edits.ts → analyze.ts
(which calls push-items.ts) → render.ts.

| Step | Reads | Local files |
|---|---|---|
| collect.ts (594 lines) | Calendar ±60d, QBO estimates/invoices 180d + all customers, Quo threads 21d active / 45d history, Gmail 21d, Redis (field completions, scheduling directives, todos, worker runlogs + heartbeats) | writes `snapshot.json` (3.4 MB); call transcripts + voicemails cached in `transcripts/` (783 files, 7.3 MB) |
| analyze.ts (1556 lines, one `main`) | snapshot, D0-D15 detectors, L1/L2 Gemini (concurrency 4) | reads `transcripts/`, `dismissals.json`; writes `findings.json` |
| push-items.ts | findings + Redis stale-quote lists + bot-draft labels | reads `quote-trigger/edit-labels.jsonl` |
| render.ts | findings, snapshot todos | writes `analysis/triage.html` |

Rule-2 debt in collect.ts: call transcripts and voicemails are raw
`fetch` to api.openphone.com (no QuoClient method yet).

## Shape

- `packages/triage` (new): `collect(deps)` → Snapshot, `analyze(snapshot,
  deps)` → FindingsFile, `triageCandidates(findings, stale, labels)` →
  ItemCandidate[]. Code moves verbatim; `main` bodies become functions
  with injected clients, store, clock and log (the 3a pattern).
  identity.ts moves with it. `addrKey`/`addrsAlike` move to
  `@aac/shared-utils/address` beside `streetKey`.
- `TriageStore` (Redis, keys in `@aac/shared-utils/redis`):
  - `triage:transcript:{callId}` and `triage:voicemail:{callId}`: the
    same cached JSON the files hold, so a call is fetched once ever.
    Seeded once from the 783 local files.
  - `triage:dismissals`: the dismissals.json rules, seeded from the file.
  - `triage:last-run`: summary + timing.
  One store for both the worker and manual runs, so they never drift.
- QuoClient gains `getCallTranscript(id)` and `getCallVoicemail(id)`
  returning the same fields collect.ts reads today.
- `apps/worker/api/triage.ts`: cron, after stale quotes finish
  (12:00-12:40 UTC), so it reads that morning's queue. Same skeleton as
  stale-quotes: mode key (off | dry | live), once per Eastern day, NX
  lock, maxDuration 800. `live` writes `keys.itemCandidates` with
  source `triage-worker`; `dry` logs counts only.
- tools/src/triage becomes thin CLIs over the package: collect/analyze
  still write snapshot.json and findings.json so render.ts and
  triage.html work unchanged.

## Proof (prod-identical)

Same method as 3a: run the old local collect + analyze and the package
against the same snapshot, recording Gemini on the old run and replaying
it into the new one; diff findings (ids, sections, severities, text)
and the item candidates. Collect is compared snapshot to snapshot.
No multi-day side-by-side (owner, 11/05): once the replay matches and
one worker `dry` run's counts look right, flip to `live` and unload
`com.aac.triage`.

## Decisions (Matt approved the defaults, 2026-11-05)

1. **Bot-draft labels.** push-items drops bot drafts Matt already
   edited/sent/deleted using `edit-labels.jsonl`, which harvest-edits
   builds from `triage/drafts.json`, i.e. only manual drafter runs, not
   the worker drafter's Redis runlog. A faithful port keeps the laptop
   file (the cloud can't read it). Proposal: the worker harvests from
   the Redis runlog instead, as a separate, approved behavior change.
   Until then the cloud skips the label filter, so already-handled bot
   drafts may show as items (the command center's own dismiss covers
   them).
2. **Time budget.** The laptop run takes ~8 min, under the 800s ceiling
   but without much margin; the Gemini L1 pass is most of it. If the
   dry runs come close, the fix is a per-thread verdict cache keyed by
   the last message (also cuts cost), shipped as its own change.
3. **Dismissals editing.** Today they're added by hand to the JSON.
   After the move they're added with a small CLI (`tools/src/triage/
   dismiss.ts`) or the command center later.
