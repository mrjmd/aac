# @aac/watchdog — outside-in pipe checks

Plan: `docs/projects/middleware-observability.md` Layer A. Runs from the
cloud worker (`apps/worker/api/watchdog.ts`, every 5 min), so it doesn't
share a Vercel project with the middleware it watches.

- `checks.ts` — pure: signals + now → one Condition per pipe (ok / down).
- `run.ts` — one tick: gather signals, diff against stored state, text Matt
  on a new outage, a 6-hour reminder, and once on recovery.

## Rules

- **P1 only.** Text Matt only when a business pipe is down: Quo events not
  reaching the middleware, a daily cron that missed its window, a dead
  worker, or the middleware health endpoint failing. Nothing that self-heals
  inside one tick, no FYIs (memory: no proactive notifications).
- Every text says what broke, since when, what it means, and the fix.
- Keys come from `@aac/shared-utils/redis`; keep `checks.ts` pure and tested.
