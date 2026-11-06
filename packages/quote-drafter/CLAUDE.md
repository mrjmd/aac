# @aac/quote-drafter — Event-Triggered Quote Drafting

You are working in the quote-drafter package: the trigger loop + drafter
core that turns customer message events into bot-marked Pending QBO
estimates. It runs in `apps/worker` (per-minute cron) with
`tools/src/drafter/run.ts` as the manual CLI over the same code.

## Rules

- **Nothing here ever sends anything to a customer.** The outputs are a
  Pending QBO estimate (never emailed) and a 🤖 note on the Quo contact.
- **All state is in Redis** (keys in `@aac/shared-utils/redis`, prefix
  `quote-trigger:` / `quote-drafter:`). No local files — the worker and
  the CLI must share one view.
- **Assets come from the Blob manifest** (`keys.quoteDrafterAssets`),
  uploaded by `tools/src/quote-trigger/sync-assets.ts`. They are business
  data and must never be committed to git.
- **Customer resolution is phone-first** (`qb.findCustomerByPhone`).
  Name-based resolution minted duplicate customers (John Skinner,
  2026-10-20) — do not reorder the chain.
- **SyncToken one-way door:** a bot draft whose current SyncToken differs
  from the stored `quoteDraftSyncToken` is HUMAN-OWNED forever. Never
  write to it.
- **Regeneration needs new inbound content.** Matt's own outbound texts
  are not "new info" (10/21 bug: T3 fired on a bot-drafted follow-up).
- **T4 (scope-change gate, 2026-10-29):** inbound content (text/voicemail/
  call transcript/email) from a phone in the open-quote index
  (`quote-draft:open`) runs a Gemini gate tuned for recall; bot-owned →
  regenerate, human-owned → flag note + `quote-drafter:scope-flags`
  (triage section). T4 stages via `quote-drafter:t4-mode` — DEFAULT
  SHADOW, independent of the global mode. Flip with
  `tools/src/quote-trigger/mode.ts t4 live`.
- **Inbound router (phase 4):** with `quote` in Redis `inbound-router:live`,
  `runTick(..., { routerOwnsInbound: true })` drops customer texts, photos
  and voicemails at drain time; the router's decision arrives as a routed job
  (`quote-trigger:routed`, put due now) and is drafted without the debounce
  or the T4 gate. Matt's outbound texts (T3), emails, call transcripts and
  Mike's debriefs still trigger here. All modes, ownership and dedupe rules
  apply to routed jobs too.
- **Mode kill-switch:** Redis `quote-drafter:mode` overrides the worker's
  `QUOTE_DRAFTER_MODE` env — `off` | `shadow` (dry-run) | `live`.
- `strict: true`; tests for new logic; run `pnpm test` after changes.
