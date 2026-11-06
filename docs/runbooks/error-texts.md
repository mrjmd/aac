# Error texts

The agent's error-surface cron (`apps/agent/api/cron/error-surface.ts`,
logic in `apps/agent/lib/error-surface.ts`, every 10 minutes) texts you new
entries from Redis `health:errors` (newest 100 failures logged by the
middleware and the worker) from the agent line.

## What the texts look like

```
[middleware error]
src: qb-reconcile
at: 2026-11-06T14:30:00.000Z
<message, up to 280 chars>
ctx: {...}
```

- `[worker error]` when the source starts with `worker:` (a worker route).
  Adds `ongoing: N errors from this route in the last hour` when it is.
- `[errors] N more errors suppressed (5-text cap per run). Sources: ...`
  when more than five texts were due in one run. Only the newest five
  text; the rest are named in that one line.

## When it texts and when it doesn't

- **First time** an error (source + first 60 chars of the message) shows
  up: texts at any hour.
- **Repeat** (same fingerprint texted in the last 7 days, any deploy):
  texts only 8 AM to 9 PM Eastern; overnight it waits until morning.
- **Same deploy, same error**: texted at most once per 24 hours. A new
  deploy resets that, so after a fix you find out whether it held.
- **Worker errors** text only when ongoing (3+ from the same route in the
  last hour) or from the watchdog itself (`worker:watchdog`). One-off
  worker errors only show on the System page.
- A send that keeps failing is retried each run and given up after 12 hours.

## How to check

1. System page, "Recent errors": the same list with full details.
2. The source names the route: `qb-reconcile`, `pipedrive`, `quo` etc.
   are middleware handlers; `worker:<route>` is `apps/worker/api/<route>.ts`.
   Open that project's function logs in Vercel around the timestamp.
3. Redis: `health:errors` (list, newest first),
   `agent:cron:error-surface:cursor` (newest entry already handled),
   `dedupe:error-surface:<sha>:<fingerprint>` (24h, texted on that deploy),
   `dedupe:error-surface-seen:<fingerprint>` (7d, "this is a repeat").

## How to fix

Fix the cause in code and push to `main`; the next deploy resets the
per-deploy dedupe, so if the error comes back you get one more text.
Errors that are a known outside outage (QuickBooks, Quo, Gemini) usually
come with a watchdog text too; follow that page.

## How to switch it off

There is no runtime switch. Repeats are already limited to daytime and
one per deploy per day. To stop error texts entirely you would remove the
error-surface cron from `apps/agent/vercel.json` and push; the watchdog
would then text that error-surface stopped (25 minutes), so don't.

If error texts stop arriving altogether, the watchdog texts
`Error alerts (agent error-surface) stopped` once its
`cron:error-surface:last-run` is 25 minutes old. Check the agent project
in Vercel (cron runs for `/api/cron/error-surface`, `CRON_SECRET`).
