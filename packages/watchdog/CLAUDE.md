# @aac/watchdog — outside-in pipe checks

Plan: `docs/projects/middleware-observability.md` Layer A. Runs from the
cloud worker (`apps/worker/api/watchdog.ts`, every 5 min), so it doesn't
share a Vercel project with the middleware it watches.

- `checks.ts` — pure: signals + now → one Condition per pipe (ok / down).
- `run.ts` — one tick: gather signals, diff against stored state, text Matt
  on a new outage (seen on 2 ticks in a row), a 6-hour reminder, and once
  on recovery. Also keeps `watchdog:mode-on` (when each mode-gated job was
  first seen on).

- `gemini.ts` — Gemini degraded, the one counted condition that texts:
  `router.read_failed` + `dispatch.classifier_rejected` 3+ in the last hour
  (the rolling window countCondition keeps), or the hourly canary
  (`runGeminiCanary`, worker `/api/gemini-canary`) not passing for 135 min.
  No verdict until the canary has passed once. Every other counted skip
  (`health:conditions:*`) goes to the command center System health page
  only, never a text.

## What it watches

| Condition | Down when |
|---|---|
| `quo-pipe` | Quo shows activity 15+ min old the middleware never acked (`webhooks:quo:last`, stamped on ack) |
| `cron:<job>` daily | no `cron:<job>:last-run` since the UTC slot + 90 min: middleware invoice-create 11, job-reminders 12, job-followups 13, deal-reconcile 14; worker ads-conversions 11, stale-quotes 12, triage 13. The worker three only while their mode is dry/live (`ADS_CONVERSIONS_MODE`, `stale-quotes:mode`, `triage:mode`) and only from the first slot after the mode was seen on |
| `cron:<job>` interval | last-run older than: qb-reconcile 75 min, sweep 35, inbound-tick 20, quote-email-tick 50, agent error-surface 25 |
| `heartbeat:worker`, `heartbeat:quote-drafter` | beat older than 20 min (quote-drafter's is suppressed while `quote-drafter:locked` is down) |
| `quote-drafter:locked` | quote-tick found the run lock taken 15 ticks in a row (`quote-drafter:skip`) |
| `quote-drafter:no-assets` | quote-tick had work but no asset manifest, until a draft runs or the manifest is back |
| `middleware-health` | the middleware's /api/health is not `healthy` |

The watchdog's own heartbeat (`health:watchdog:ts`) is read by the agent's
error-surface cron (daytime text) and by the worker's /api/health for the
outside pinger. `__tests__/cron-drift.test.ts` fails when a cron in any
app's vercel.json is neither watched nor listed as deliberately unwatched.

## Rules

- **P1 only.** Text Matt only when a business pipe is down: Quo events not
  reaching the middleware, a cron that missed its window or stopped, a dead
  worker, a stuck quote drafter, the alert channel itself, or the
  middleware health endpoint failing. Nothing that self-heals
  inside one tick, no FYIs (memory: no proactive notifications).
- Every text says what broke, since when, what it means, and the fix.
- Keys come from `@aac/shared-utils/redis`; keep `checks.ts` pure and tested.
