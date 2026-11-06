# QuickBooks reconnect

QuickBooks Online tokens live in one Redis key, `oauth:quickbooks:tokens`,
shared by every app (middleware, worker, command center, tools). Intuit
rotates the refresh token on every refresh; a single-flight lock
(`oauth:quickbooks:refresh-lock`, 30s) stops two apps refreshing at once.
If the refresh token dies (revoked, expired after about 100 days unused,
or stranded by a race), every QBO call fails until you reconnect.

## Signs it's disconnected

- Watchdog text `Middleware cron qb-reconcile stopped`: qb-reconcile
  returns `skipped: qb_not_connected` without stamping
  `cron:qb-reconcile:last-run`, so it goes stale after 75 minutes.
- `[middleware error]` texts from QuickBooks calls (invoice-create,
  qb-reconcile, pipedrive) with token or 401 errors.
- System page "Silent skips": `pd-webhook.qb_disconnected` ("Pipedrive
  sync: QuickBooks disconnected, customer not synced").

## How to reconnect

1. Open, in a browser, on the middleware:

   ```
   https://aac-middleware-monorepo.vercel.app/api/auth/quickbooks/connect?key=<CRON_SECRET>
   ```

   `<CRON_SECRET>` is the middleware's `CRON_SECRET` env value. Without
   the right key the page answers `Unauthorized`.
2. Sign in to Intuit and approve the AAC company. **Finish within 10
   minutes**: `/connect` stores a one-time state nonce
   (`oauth:quickbooks:state:<state>`, 10-minute TTL) that the callback
   consumes.
3. The callback (`/api/auth/quickbooks/callback`) checks the state, checks
   the company matches `QUICKBOOKS_REALM_ID`, and saves the new tokens to
   `oauth:quickbooks:tokens`. Every app picks them up on its next call; no
   redeploy.

If the callback says:

- `Invalid or expired state`: you took longer than 10 minutes or reused
  the link. Start again from step 1.
- `Wrong QuickBooks company`: you approved a different company. No tokens
  were saved; start again and pick the AAC company.
- `QuickBooks connect is not configured`: `CRON_SECRET` isn't set on the
  middleware project.

## Afterwards

- qb-reconcile's next run (every 30 minutes) stamps its last-run and the
  watchdog sends `✅ Recovered`. Its 7-day window catches up acceptances
  missed while disconnected; customer acceptances fire no Intuit webhook,
  so this cron is what records them.
- Jobs not invoiced while it was down show on the System page under
  "Jobs not invoiced" (`invoice-create.*` silent skips).

## How to switch it off

There is nothing to switch off: without tokens the QBO paths skip or fail
and log. Don't paste tokens into Redis by hand and don't hand-wire tokens
in scripts; tools get QBO through `quickBooksFromEnv()`, which uses the
shared token store and refresh lock.
