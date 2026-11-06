# @aac/triage — Triage dashboard pipeline

The gap detectors behind triage.html and the command center's triage items:
collect a snapshot (Calendar, QBO, Quo, Gmail, Redis), run the D0-D15
deterministic detectors and the L1/L2 Gemini pass over it, and turn the
findings plus the stale-quote and bot-draft sections into item candidates.
Moved from `tools/src/triage/` (2026-11-05) so the worker can run it.

Plan: `docs/plans/triage-to-worker.md` (cleanup step 3b).

- `collect.ts`: `collect(deps)` → `Snapshot`.
- `analyze.ts`: `analyze(snapshot, deps)` → `FindingsFile`: detectors,
  L1/L2 verdicts, booked-customer suppression, dismissals, pulse.
- `candidates.ts`: `triageCandidates(findings, staleLists, { now, labels?,
  legacyBotLog? })` → `ItemCandidate[]` (pure), `publishTriageItems({ redis },
  { at, source, candidates })` → `keys.itemCandidates`. Also `loadAwaiting`
  and `botDraftRows`, which render.ts draws from.
- `dismissals.ts`: `addDismissal` / `removeDismissal` /
  `validateDismissalRule` over the store, `TRIAGE_SECTIONS`.
- `identity.ts`: one identity cross-reference (union-find over QBO ids,
  phones, emails, names; addresses attach only).
- `address.ts`: triage's token address match (`addrKey`/`addrsAlike`),
  built on `@aac/customers` name tokens.
- `store.ts`: `TriageStore` (transcript + voicemail cache, dismissals,
  verdict cache);
  `RedisTriageStore` and `MemoryTriageStore` (tests, proofs, dry runs).

## Callers

- `apps/worker/api/triage.ts`: the daily cron (13:05 UTC, after stale
  quotes), mode `triage:mode` (off | dry | live). Runs collect → analyze →
  `triageCandidates(findings, stale, { now })` with no labels or legacy log
  (plan decision 1) and, live, publishes with source `triage-worker`.
  Wiring in `apps/worker/lib/triage-deps.ts` + `triage-run.ts`.
- `tools/src/triage/refresh.sh`: by hand (launchd `com.aac.triage` until
  the worker runs live). Chains `collect.ts` (writes snapshot.json), quote-trigger
  harvest-edits, `analyze.ts` (writes findings.json, then calls
  `push-items.ts` unless `--no-push`) and `render.ts` (triage.html).
- `tools/src/triage/push-items.ts`: publishes candidates with source
  `triage-laptop`, passing the bot-draft edit labels
  (`analysis/data/quote-trigger/edit-labels.jsonl`) and the legacy
  shadow-log. `--dry-run` counts only.
- `tools/src/triage/dismiss.ts`: `list [--all]`, `add "<match>" --reason ...
  [--sections a,b] [--until YYYY-MM-DD]`, `remove "<match>" [--sections a,b]`;
  `--dry-run` edits an in-memory copy.
- `tools/src/triage/seed-store.ts`: one-time seed of the store from the
  laptop files (`--dry-run` to count).

## State (Redis, keys in `@aac/shared-utils/redis`)

- `triage:transcript:{callId}` / `triage:voicemail:{callId}`: the cached
  Quo call transcript / voicemail (`transcript: null` = rang out). No TTL;
  a call is fetched once ever.
- `triage:verdict:{sms|email}:{threadId}:{hash}`: the per-thread L1/L2
  Gemini verdict cache (plan decision 2), 7-day TTL, shared by the worker and
  manual runs. `hash` = `verdictHash(userPrompt, lastActivityAt)`: the
  thread's full prompt + last activity + `VERDICT_CACHE_SALT` (version,
  model, generation params, the system-prompt template with its run context
  blanked). New activity or a prompt/model/param edit misses; bump the salt
  version to drop all. The calendar, estimates and date are NOT keyed (they
  change every run), so cached `booked_gap` / `quote_promised` verdicts are
  always re-asked. Errors and parse failures are never cached; fresh
  verdicts are written as they return. `stats.llmCacheHits` counts reuse.
- `triage:dismissals`: the owner's suppression rules, `{ match, sections?,
  reason?, addedAt?, until? }`. Edit with dismiss.ts, never raw.
- `triage:mode`, `triage:last-run`, `triage:run-lock`: the worker cron's
  mode, last-run summary (counts + timing) and NX run lock.
- Reads: `stale-quotes:queue` / `stale-quotes:awaiting` (through
  `@aac/stale-quotes`), field completions, scheduling directives, todos,
  worker runlogs and heartbeats (collect). Writes `keys.itemCandidates` only
  through `publishTriageItems`.

## Rules

- No `process.env`, no file I/O, no `Date.now()` in the package: clients,
  env values (`QUO_PHONE_NUMBER`, `GEMINI_API_KEY`, `TECHNICIAN_EMAILS`),
  the clock, logging, the store and any laptop files (edit labels,
  shadow-log) come in from the caller.
- `analyze` and `triageCandidates` are deterministic given their inputs.
  Detector, threshold, prompt, model or candidate-mapping changes are
  behavior changes: ship them as their own approved commits, never inside a
  refactor, and prove refactors identical against live data first.
- Adding a `Section` means adding it to `TRIAGE_SECTIONS` too (the build
  fails otherwise).
