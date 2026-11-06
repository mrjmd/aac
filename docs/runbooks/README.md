# Runbooks

What to do when a text or alert fires. One page per system. Every page
says what the alert means, how to check it, how to fix it, and how to
switch the thing off.

Where to look first, for everything: the command center **System** page,
`https://hq.attackacrack.com/health`. It is built from Redis only, so it
works even when the middleware or worker is down. Sections: Open watchdog
alerts (`watchdog:state`), Jobs not invoiced, CI on main, Silent skips
(`health:conditions:*`), Heartbeats and crons (`health:*:ts`,
`cron:*:last-run`), Recent errors (`health:errors`).

| Text or alert | Page |
|---|---|
| `⚠️ ... DOWN / stopped / missed its run` and `✅ Recovered: ...` from the agent line | [watchdog.md](watchdog.md) |
| `⚠️ The pipe watchdog stopped` | [watchdog.md](watchdog.md#the-watchdog-itself-stopped) |
| `[middleware error]` / `[worker error]` / `[errors] N more errors suppressed` | [error-texts.md](error-texts.md) |
| `⚠️ Gemini (drafts, intake replies, scheduling) failing` | [gemini-degraded.md](gemini-degraded.md) |
| `Quote drafter stuck on its run lock` / `Quote drafter has no asset manifest` | [quote-drafter.md](quote-drafter.md) |
| `Stale-quote follow-up missed its run` / `Daily triage missed its run` | [worker-daily-crons.md](worker-daily-crons.md) |
| `Middleware cron qb-reconcile stopped`, QuickBooks errors, "QuickBooks disconnected" skips | [qbo-reconnect.md](qbo-reconnect.md) |
| `Quo → middleware pipe DOWN` | [quo-webhook.md](quo-webhook.md) |
| Redis keys: what each one is, which ones grow | [redis-keys.md](redis-keys.md) |

## Switches at a glance

| Thing | Off switch | Where |
|---|---|---|
| Quote drafter | `npx tsx tools/src/quote-trigger/mode.ts off` (or `clear` to go back to the `QUOTE_DRAFTER_MODE` env default) | Redis `quote-drafter:mode` |
| Quote drafter T4 (scope change) only | `npx tsx tools/src/quote-trigger/mode.ts t4 off` | Redis `quote-drafter:t4-mode` |
| Stale-quote follow-up | set `stale-quotes:mode` to `off` (or delete it) | Redis |
| Daily triage (worker) | set `triage:mode` to `off` (or delete it) | Redis |
| Inbound router | delete `inbound-router:mode` (unset = off); remove a route from `inbound-router:live` to give it back to the old path | Redis |
| Google Ads conversions upload | `ADS_CONVERSIONS_MODE=off` | worker env in Vercel, then redeploy from git |

Run the `tools/` scripts from the repo root (they read `.env.diagnostic`
there). For the Redis keys with no script, use any Redis client against
the shared Upstash database, for example a short tools script with
`redisFromEnv()` from `tools/src/lib/env.ts`.

Never fix production by `vercel deploy`. Code fixes go through git (push
to `main` deploys).
