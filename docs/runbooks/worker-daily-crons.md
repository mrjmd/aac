# Stale quotes and daily triage (worker crons)

Two daily worker jobs, each switched by a Redis mode key:

| Job | Route | Schedule (UTC) | Mode key | Does |
|---|---|---|---|---|
| Stale-quote follow-up | `/api/stale-quotes` | 12:00, 12:20, 12:40 | `stale-quotes:mode` | scans every Pending quote, posts `📋 STALE-QUOTE FOLLOW-UP` Quo notes for due follow-ups (never sends) |
| Daily triage | `/api/triage` | 13:05 | `triage:mode` | collect → analyze → publishes items to the command center Today page |

Modes: `off` | `dry` | `live`. **Unset = off.**

- `stale-quotes`: `dry` refreshes only the awaiting-reply list
  (`stale-quotes:awaiting`); `live` also drafts the notes.
- `triage`: `dry` runs the whole pipeline and records counts only;
  `live` also publishes to `cc:items:candidates` (source `triage-worker`).

Each runs once per Eastern day per mode. Stale quotes: the first slot
scans; later slots finish a scan its 600s budget cut short, then skip.
Triage: one slot with a 720s deadline; past it the run is dropped
unpublished and recorded as an error.

## The texts

`Stale-quote follow-up missed its run` / `Daily triage missed its run`
from the [watchdog](watchdog.md): no `cron:stale-quotes:last-run` since
12:00 UTC + 90 min (or `cron:triage:last-run` since 13:00 UTC + 90 min).
Only while the mode is `dry` or `live`, and only from the first slot after
the watchdog saw the mode switched on, so turning a job on mid-day doesn't
text.

A `[worker error] src: worker:triage` text with `triage run degraded: ...`
means it finished but part of it was blind (LLM errors, email sweep
failed, Gemini canary failed); it texts only when ongoing (see
[error-texts.md](error-texts.md)).

## How to check

1. System page, "Heartbeats and crons": `stale-quotes`, `triage` rows
   (last run and today's result).
2. Redis `stale-quotes:last-run` / `triage:last-run`: JSON summary of the
   last completed run (`day`, `mode`, counts; stale quotes adds
   `partial`, triage adds timings and `llmErrors`).
3. The route's JSON answer in the worker logs says why it skipped:
   `off`, `done-today`, `locked`, `no-google-env` (stale quotes) or
   `no-<group>-env` (triage).
4. Locks: `stale-quotes:run-lock` (900s), `triage:run-lock` (900s). A
   killed run's lock expires before the next day's slot.

## How to fix

- Cron didn't run at all: aac-worker-monorepo in Vercel, cron runs for the
  route, the latest deploy.
- 500 / timeout: worker function logs. Google env missing or a Google
  token without calendar or Gmail access stops stale quotes (they are hard
  gates).
- To run again today after a fix: call the route with `?force=1` and the
  `x-worker-secret` header (`WORKER_SHARED_SECRET`). Cron auth alone
  doesn't allow `force`.

## How to switch it off

Set the Redis key to `off` (or delete it):

```
stale-quotes:mode = off
triage:mode = off
```

No redeploy. The watchdog stops watching the job and forgets when it was
switched on (`watchdog:mode-on`), so switching it back on later doesn't
text for slots that already passed.
