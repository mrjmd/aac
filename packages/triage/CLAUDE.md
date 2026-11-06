# @aac/triage — Triage dashboard pipeline

Plan: `docs/plans/triage-to-worker.md` (cleanup step 3b). The gap
detectors behind triage.html and the command center's triage items, moved
from `tools/src/triage/` so the worker can run them.

- `collect.ts` — `collect(deps)` → `Snapshot`: Calendar ±60d, QBO
  estimates/invoices/customers, Redis queues + worker runlogs, Quo threads
  (with call transcripts and voicemails), Gmail.
- `analyze.ts` — `analyze(snapshot, deps)` → `FindingsFile`: D0-D15
  deterministic detectors, L1/L2 Gemini verdicts, booked-customer
  suppression, dismissals, pulse.
- `identity.ts` — one identity cross-reference (union-find over QBO ids,
  phones, emails, names; addresses attach only).
- `address.ts` — triage's token address match (`addrKey`/`addrsAlike`),
  built on `@aac/customers` name tokens.
- `store.ts` — `TriageStore`: transcript + voicemail cache and dismissals.
  `RedisTriageStore` (keys `triageTranscript`, `triageVoicemail`,
  `triageDismissals`) and `MemoryTriageStore` (tests, dry runs).

## Rules

- No `process.env`, no file I/O, no `Date.now()` in the package: clients,
  env values (`QUO_PHONE_NUMBER`, `GEMINI_API_KEY`, `TECHNICIAN_EMAILS`),
  the clock, logging and the store come in through deps.
- `analyze` is deterministic given the snapshot, store contents, clock and
  Gemini responses. Detector, threshold, prompt or model changes are
  behavior changes: ship them as their own approved commits, never inside
  a refactor.
- CLIs: `tools/src/triage/collect.ts` / `analyze.ts` (write snapshot.json /
  findings.json for render.ts). `tools/src/triage/seed-store.ts` is the one-time
  seed of the store from the laptop files (`--dry-run` to count).
