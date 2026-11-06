# Watchdog texts

The watchdog (`packages/watchdog`, run by the worker's `/api/watchdog`
every 5 minutes) checks each business pipe from the outside and texts you
from the agent line (617-766-0151) when one is down. If the Quo send
fails, the alert goes by email instead (`WATCHDOG_ALERT_EMAIL`, or the
worker Google token's own mailbox).

## How it texts

- A condition must be down on **2 ticks in a row** (about 10 minutes)
  before the first text. One blip never texts.
- While it stays down, a reminder every **6 hours** (`⚠️ STILL DOWN: ...`).
- One `✅ Recovered: ...` text when it clears, only if you were texted.
- Every text has the format: what broke, since when, what it means, `Fix:`.

State lives in Redis `watchdog:state` (hash: condition id → `{since,
firstSeenAt, ticks, alertedAt}`). The System page shows it under "Open
watchdog alerts".

## The conditions

| Condition id | Down when | First check | Fix |
|---|---|---|---|
| `quo-pipe` | Quo shows activity 15+ min old that the middleware never acked (`webhooks:quo:last`) | [quo-webhook.md](quo-webhook.md) | re-enable the Quo webhook |
| `cron:invoice-create` | no run since 11:00 UTC + 90 min | System page, "Heartbeats and crons" | middleware project in Vercel: cron logs, latest deploy |
| `cron:job-reminders` | no run since 12:00 UTC + 90 min | same | same |
| `cron:job-followups` | no run since 13:00 UTC + 90 min | same | same |
| `cron:deal-reconcile` | no run since 14:00 UTC + 90 min | same | same |
| `cron:ads-conversions` | no run since 11:00 UTC + 90 min, only while `ADS_CONVERSIONS_MODE` is dry/live | same | aac-worker-monorepo in Vercel |
| `cron:stale-quotes`, `cron:triage` | no run since 12:00 / 13:00 UTC + 90 min, only while their Redis mode is dry/live | [worker-daily-crons.md](worker-daily-crons.md) | |
| `cron:qb-reconcile` | last run older than 75 min | [qbo-reconnect.md](qbo-reconnect.md) (a QBO disconnect stops it) | |
| `cron:sweep` | older than 35 min | System page | aac-worker-monorepo in Vercel |
| `cron:inbound-tick` | older than 20 min | System page | same |
| `cron:quote-email-tick` | older than 50 min | System page; if the route answers `skipped: no-gmail-scope`, the Google token lost Gmail read | same, or re-auth Google |
| `cron:error-surface` | older than 25 min | [error-texts.md](error-texts.md) | agent project in Vercel: `/api/cron/error-surface` runs, `CRON_SECRET` |
| `heartbeat:worker` | `health:worker:ts` older than 20 min | System page | aac-worker-monorepo in Vercel |
| `heartbeat:quote-drafter` | `health:quote-drafter:ts` older than 20 min (not while `quote-drafter:locked` is down) | [quote-drafter.md](quote-drafter.md) | |
| `quote-drafter:locked` | quote-tick found the run lock taken 15 ticks in a row | [quote-drafter.md](quote-drafter.md) | |
| `quote-drafter:no-assets` | quote-tick had work but no asset manifest | [quote-drafter.md](quote-drafter.md) | |
| `middleware-health` | middleware `/api/health` is not `healthy` | System page "Recent errors"; middleware in Vercel | |
| `gemini-degraded` | see [gemini-degraded.md](gemini-degraded.md) | | |

"Missed its run" for a daily cron means its `cron:<job>:last-run` stamp
didn't move. Crons stamp only after a run that did its work, so a cron
that ran but failed (500) or skipped also shows as missed.

## How to check

1. System page: "Open watchdog alerts" lists what is open and since when;
   "Heartbeats and crons" shows every stamp's age.
2. The Vercel project named in the `Fix:` line: cron runs and function
   logs for that route.
3. Redis: `cron:<job>:last-run` (ISO), `health:<name>:ts` (ISO),
   `watchdog:state`.

## How to switch it off

There is no watchdog kill switch. To silence one job's daily-cron check,
turn that job's mode off (stale-quotes, triage, ads-conversions); the
watchdog only watches them while they are on. To quiet a condition you're
already working on, just fix it: you get one reminder every 6 hours at
most.

## The watchdog itself stopped

`⚠️ The pipe watchdog stopped (last check ...)` comes from the agent's
error-surface cron, not the watchdog: `health:watchdog:ts` is older than
30 minutes. Daytime only (8 AM to 9 PM Eastern), one text per outage. It
means the worker is probably down, so no other outage will be texted.

- Check: aac-worker-monorepo in Vercel (cron runs, function errors, the
  latest deploy). The System page "Watchdog" row shows the last beat.
- The worker's `/api/health` answers 503 while the watchdog heartbeat is
  over 15 minutes old; an outside uptime pinger on it is the alarm that
  doesn't share fate with Vercel crons.
