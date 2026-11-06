# Redis keys: growth audit

Every key builder in `packages/shared-utils/src/redis.ts` (`keys.*`), who
writes it, who reads it, and whether it can grow without bound. Audited
2026-11-06 against the code and a read-only count of the production
database (4,034 keys total).

Verdicts:

- **bounded**: fixed number of keys, TTL'd, capped list, or pruned.
- **fixed 11/06**: grew forever, now bounded (see "Changes" below).
- **grows (by design)**: source of truth or long-lived state; growth is
  real data, not leakage.
- **needs Matt**: grows, and the right bound is a judgment call.
- **unused**: builder exists, nothing in apps/, packages/ or tools/ uses it.

"Live" counts are from 2026-11-06.

## Health and observability

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `health:{app}:ts` (`heartbeat`) | string | shared-utils `writeHeartbeat` (middleware, worker tick, quote-tick, watchdog, gemini-canary) | watchdog, CC /health, agent watchdog-watch, worker /api/health | one key per app | bounded |
| `webhooks:{source}:{date}:count` | string | shared-utils `trackWebhookProcessed` | middleware /api/health, CC /health | EXPIRE 48h | bounded |
| `webhooks:{source}:last` | string | shared-utils `trackWebhookProcessed` | watchdog (quo-pipe), CC /health | one per source | bounded |
| `health:errors` | list | shared-utils `logHealthError` | agent error-surface, CC /health, middleware /api/health | LTRIM 100 | bounded |
| `health:errors:throttle:{source}` | string | worker `lib/health.ts` | same | SET NX EX 10 min | bounded |
| `health:conditions:{day}` | hash | shared-utils `countCondition` | CC /health | EXPIRE 14d | bounded |
| `health:conditions:{day}:entities` | hash | shared-utils `countCondition` | CC /health | EXPIRE 14d | bounded |
| `health:conditions:recent:{name}` | zset | shared-utils `countCondition` | watchdog gemini.ts (last hour) | ZREMRANGEBYSCORE 2h + EXPIRE 2h | bounded |
| `cron:{job}:last-run` | string | shared-utils `trackCronRun`, ads-conversions | watchdog, CC /health | one per job | bounded |
| `cron:{job}:{date}:result` | string | shared-utils `trackCronRun` | CC /health | EX 30d | bounded |
| `cron:{action}:{entityId}` (`cronAction`) | string | middleware `markCronAction` (reminder, followup, invoice-send, invoice-create, suggestion-note) | same (SET NX) | EX 7d default | bounded |
| `watchdog:state` | hash | watchdog run.ts | watchdog, CC /health | fields HDEL'd on recovery | bounded |
| `watchdog:mode-on` | hash | watchdog run.ts | watchdog | one field per gated job | bounded |
| `logs:webhooks` (`webhookAuditStream`) | | none | none | | unused |

## Dedup, loop prevention, locks

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `dedupe:{source}:{eventId}` | string | middleware `markEventProcessed`; agent (quo-agent, error-surface 24h, error-surface-seen 7d, watchdog-offline 7d) | same | EX 24h or 7d | bounded |
| `created-by-us:{system}:{id}` | string | middleware | middleware | EX 60s | bounded |
| `lock:create:{system}:{phone}` | string | middleware | middleware | EX 30s | bounded |
| `oauth:quickbooks:refresh-lock` | string | shared-utils `qboTokenStore` | api-clients QuickBooksClient | PX 30s | bounded |
| `oauth:quickbooks:state:{state}` | string | middleware /api/auth/quickbooks/connect | callback (DEL) | EX 10 min | bounded |
| `quote-trigger:lock:{phone}` | | none | none | | unused |
| `quote-drafter:run-lock` | string | quote-drafter `runTick` | same | PX 15 min | bounded |
| `stale-quotes:run-lock` | string | worker /api/stale-quotes, tools stale-quotes/run.ts | same | EX 900s | bounded |
| `triage:run-lock` | string | worker /api/triage | same | EX 900s | bounded |
| `inbound:lock:{phone}` | string | inbound-router tick | same | EX 900s, DEL after | bounded |

## ID maps, OAuth, sessions

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `map:pd-to-quo:*`, `map:quo-to-pd:*`, `map:pd-to-qb:*`, `map:qb-to-pd:*`, `phone:pd:*` | string | middleware `lib/redis.ts` | middleware | EX 7d | bounded (about 15 no-TTL keys left by older code; current writers all set EX) |
| `oauth:quickbooks:tokens` | string | shared-utils `qboTokenStore` | every QBO client | none, one key | bounded (source of truth) |
| `field:google-tokens:{email}` | string | field OAuth callback | field | none, one per user | bounded (source of truth) |
| `field:user-config:{email}` | string | field | field | none, one per user | bounded |
| `field:session:{id}`, `cc:session:{id}` | string | field, CC | same | EX 1y / 30d, renewed | bounded |
| `field:oauth-state:*`, `cc:oauth-state:*` | string | field, CC | same | EX 10 min | bounded |

## Field app and scheduling

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `field:completion:{eventId}` | string | field `completion.ts` | middleware, triage, scheduling stub enrichment | none (140 live) | grows (by design): job completion record and photos |
| `drive:file-info:{fileId}` | string | field `drive.ts` | field | EX 30 min / 24h (7 legacy no-TTL keys) | bounded |
| `field:event-customer:{eventId}` | string | field | field | EX 24h | bounded |
| `field:travel-leg:{key}` | string | field, scheduling travel-time | same | EX 30d | bounded |
| `scheduling:pending:{directiveId}` | string | middleware `writePendingDirective` | CC /scheduling (top 100 of each list), triage collect (top 50), middleware by id | none (1,542 live; 781 no longer on either list) | **needs Matt** |
| `scheduling:pending:list` | list | middleware | CC, triage | LTRIM 500 | bounded |
| `scheduling:pending-review:list` | list | middleware | CC, triage | LTRIM 500 (260 live, oldest May 31) | bounded |
| `scheduling:directive-by-qb-estimate:{id}` | string | middleware (directive, `manual-scheduled:*`, `booking-sync:*` markers) | qb-webhook, qb-reconcile | none (105 live) | **needs Matt** |
| `scheduling:booking-sync:{eventId}` | string | middleware `setBookingSyncOutcome` | qb-reconcile booking sync (events starting in the next 60 days) | final: was none, now EX 1y; none/ambiguous EX 24h | fixed 11/06 |
| `scheduling:classifier-count:*`, `scheduling:directives-from-quo:*` | string | middleware | middleware /api/health | EXPIRE 30d | bounded |
| `scheduling:proposal-decision:*`, `scheduling:proposal-by-directive:*` | string | middleware | CC /scheduling | EX 30d | bounded |
| `agent:proposal:*`, `agent:active-proposal:*` | string | agent | agent | EX 24h | bounded |
| `agent:cron:{job}:cursor` | string | agent | agent | none, one per job | bounded |
| `agent:audit:stream` | list | agent | CC | LTRIM 1000 | bounded |
| `agent:rules:{phone}` | | none | none | | unused |
| `followup:variant:{eventId}` | string | middleware `lib/followup.ts` (hardcoded, no key builder) | none in code yet | EX 1y (101 live) | bounded; see "Other findings" |

## Quote drafter and message drafts

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `quote-trigger:queue` | list | middleware, quote-drafter email-poll | quote-drafter (drained) | LTRIM 1000 | bounded |
| `quote-trigger:pending` | hash | quote-drafter | quote-drafter (HDEL when due) | drained | bounded |
| `quote-trigger:due` | zset | quote-drafter, inbound-router | quote-drafter (ZREM when due) | drained | bounded |
| `quote-trigger:routed` | hash | quote-drafter `enqueueRoutedQuote` | quote-drafter (HDEL) | drained | bounded |
| `quote-trigger:t2-done` | hash | quote-drafter | quote-drafter (24h window) | fields pruned at 7d each tick | bounded |
| `quote-trigger:t4-done` | hash | quote-drafter | quote-drafter (24h window) | was never pruned, now pruned at 7d each tick | fixed 11/06 |
| `quote-trigger:email-seen` | hash | quote-drafter email-poll | same | fields pruned at 7d | bounded |
| `quote-draft:open` | hash | quote-drafter, middleware qb-reconcile | quote-drafter T4 | rebuilt from QBO every 30 min | bounded |
| `quote-draft:open-synced-at` | string | quote-drafter | quote-drafter | one key | bounded |
| `quote-draft:sync:{estimateId}` | string | quote-drafter `drafter.ts` | quote-drafter (ownership), tools harvest-edits | none (35 live) | **needs Matt** |
| `quote-drafter:mode`, `quote-drafter:t4-mode` | string | tools/src/quote-trigger/mode.ts | quote-drafter, triage | one key | bounded (mode) |
| `quote-drafter:skip` | string | worker `lib/quote-skip.ts` | watchdog | one key, DEL on a good tick | bounded |
| `quote-drafter:assets` | hash | tools/src/quote-trigger/sync-assets.ts | worker, quote-drafter | 4 fields | bounded |
| `quote-drafter:runlog` | list | quote-drafter | triage, tools harvest-edits | LTRIM 500 | bounded |
| `quote-drafter:scope-flags` | list | quote-drafter | triage | LTRIM 200 | bounded |
| `message-drafts:queue` | list | middleware | message-drafts tick (LPOP) | LTRIM 200 | bounded |
| `message-drafts:intake-due` | zset | middleware, message-drafts | message-drafts tick (ZREM) | drained | bounded |
| `message-drafts:followup-done` | hash | message-drafts | message-drafts | none, one field per estimate ever drafted (20 live) | grows (by design): "never draft this quote again" |
| `message-drafts:intake-done` | hash | message-drafts, inbound-router | message-drafts | none, one field per phone ever drafted (88 live) | grows (by design): "never first-touch this phone again" |
| `message-drafts:referral-done` | hash | message-drafts | message-drafts referral (24h window) | was never pruned, now pruned at 7d on write | fixed 11/06 |
| `message-drafts:note-attempts` | hash | message-drafts | message-drafts | HDEL on success; a give-up leaves its field | bounded in practice (0 live) |
| `message-drafts:first-run-at`, `message-drafts:last-sweep` | string | message-drafts, tools runner | same | one key | bounded |
| `message-drafts:runlog` | list | message-drafts | triage, CC /referrals | LTRIM 500 | bounded |

## Inbound router

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `inbound:due` | zset | middleware, inbound-router sweep | inbound-router tick (ZREM) | drained | bounded |
| `inbound:first` | hash | middleware, inbound-router | inbound-router (HDEL) | drained | bounded |
| `inbound:read:{phone}` | string | inbound-router | inbound-router | EX 30d | bounded |
| `inbound-router:mode`, `inbound-router:live` | string | set by hand | inbound-router | one key | bounded (mode) |
| `inbound:shadow` | list | inbound-router | review | LTRIM 500 | bounded |

## Stale quotes, triage, items, Ads

| Key pattern | Type | Writer(s) | Reader(s) | TTL / bound | Verdict |
|---|---|---|---|---|---|
| `stale-quotes:state` | hash | stale-quotes | stale-quotes | entries pruned when the quote leaves Pending | bounded (source of truth) |
| `stale-quotes:queue`, `:awaiting`, `:last-run`, `:mode` | string | stale-quotes, worker | worker, watchdog, triage | one key each | bounded |
| `stale-quotes:runlog` | list | stale-quotes | review | LTRIM 5000 | bounded |
| `triage:transcript:{callId}` | string | triage store, tools seed-store | triage | none (392 live) | grows (by design): fetched once ever |
| `triage:voicemail:{callId}` | string | triage store, tools seed-store | triage | none (391 live) | grows (by design) |
| `triage:dismissals`, `triage:mode`, `triage:last-run` | string | triage, worker, by hand | triage, worker, watchdog | one key | bounded |
| `triage:verdict:{channel}:{thread}:{hash}` | string | triage store | triage | EX 7d | bounded |
| `cc:items:candidates` | string | triage, tools push-items | CC | one key | bounded |
| `cc:items:state` | hash | CC items | CC | stale states HDEL'd on each reconcile (219 live) | bounded |
| `cc:items:mutes`, `cc:people`, `can-help:referrals`, `can-help:rules` | hash | CC, tools seed | CC, quoting | owner-edited | bounded (source of truth) |
| `cc:items:rank-log` | list | CC items | training data | LTRIM 10,000 | bounded |
| `cc:snap:{name}` | string | CC snapshots | CC | EX 30d | bounded |
| `todo:{id}`, `todo:list` | string, zset | CC, tools todos | CC, triage | DEL on delete | grows (by design) |
| `ads-conversions:clicks` | hash | ads-conversions | same | fields pruned at 90d | bounded |
| `ads-conversions:sent` | set | ads-conversions | same | none (54 live, one per uploaded conversion) | grows (by design): "never re-send this orderId" |
| `ads-conversions:last-summary` | string | ads-conversions | health | one key | bounded |

## Campaigns, suppression, attribution (legacy schema)

`campaign:*`, `campaigns:active`, `stats:campaign:*`, `optouts:phones`,
`suppression:dnc`, `suppression:litigators`, `suppression:landlines`,
`attribution:*`, `attribution:processed:*`: no code in this repo reads or
writes them (**unused**). The keys that exist in Redis were written by
the archived aac-slim / attackacrack apps. The suppression and opt-out
sets are permanent compliance lists; keep them.

## Changes made 11/06

| Key | Bound added | Longest reader lookback |
|---|---|---|
| `scheduling:booking-sync:{eventId}` (final outcomes) | EX 1 year (`ttl.bookingSyncFinal`) | events starting in the next 60 days (`BOOKED_LOOKAHEAD_DAYS`) |
| `quote-trigger:t4-done` fields | pruned after 7 days on every quote tick | 24h (`T4_DEDUPE_H`) |
| `message-drafts:referral-done` fields | pruned after 7 days on every write | 24h (`REFERRAL_REPEAT_H`) |

Hash fields have no TTL of their own and a whole-key TTL would wipe fresh
fields with stale ones, so the two hashes are pruned instead, the same way
`quote-trigger:t2-done` already was.

## Needs Matt

1. **`scheduling:pending:{directiveId}`** (1,542 keys, the biggest grower).
   The two lists are capped at 500, but LTRIM leaves the blobs behind:
   781 blobs are on neither list and only reachable by id. A flat TTL is
   not safe: the CC reads the top 100 of the review list, and entry 100
   there is from Aug 13 (the list's tail is May 31). Proposed fix: when
   `writePendingDirective` trims a list, DEL the blobs of the ids it
   trimmed off (and one-time delete the 781 orphans). Middleware change,
   so your call.
2. **`scheduling:directive-by-qb-estimate:{estimateId}`** (105 keys). The
   qb-webhook re-checks it whenever an Accepted estimate is edited, at any
   age, to avoid a second directive. A TTL would let an old estimate edit
   create a duplicate directive. Grows by about one per accepted quote; a
   possible bound is deleting it once the estimate is invoiced.
3. **`quote-draft:sync:{estimateId}`** (35 keys). The bot's ownership
   fingerprint. An estimate can stay Pending for months (stale quotes go
   to 90 days), so a TTL could flip a bot-owned quote to human-owned.
   Possible bound: delete it when the open-quote index sync drops the
   estimate (no longer Pending).
4. **`triage:transcript:*` / `triage:voicemail:*`** (783 keys, no TTL by
   design: fetched once ever). If the size ever matters, a 1-year TTL
   would only cost a refetch for calls older than any triage lookback.
5. **Legacy keys from the old apps**: deleted 11/06 (`cache:searchbug-raw`,
   `cache:verified-clean`, `ever-messaged`, `settings:global`, 11
   `campaign:campaign-*test*` keys). Values backed up locally in
   `analysis/data/redis-backups/legacy-keys-2026-11-06.json`. Kept:
   `optouts:phones`, `suppression:*`, `campaigns:active`, `campaign:drafts`.

## Other findings

- `apps/middleware/lib/followup.ts` writes `followup:variant:{eventId}` as a
  hardcoded string (root CLAUDE.md rule 6: keys come from
  `@aac/shared-utils/redis`). It has a 1-year TTL, so it is bounded; it
  should get a key builder next time that file is touched.
- `tools/src/setup/backfill-deal-spine.ts` hand-wires QBO tokens (its own
  `saveTokens` with a 90-day TTL on `oauth:quickbooks:tokens`) instead of
  the shared token store and refresh lock (tools/CLAUDE.md). The next
  normal refresh rewrites the key without a TTL, but running that script
  can race the refresh lock. Port it to `quickBooksFromEnv()` before it is
  run again.
- The doc comment on `keys.quoteEmailSeen` says 24h; the code prunes at 7
  days (`EMAIL_SEEN_TTL_MS`).
