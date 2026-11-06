# Quote drafter: locked, no assets, stopped

The quote drafter runs in the worker: `/api/quote-tick` every minute
(`packages/quote-drafter`, `runTick`). It turns settled customer threads
into bot-marked Pending QBO estimates plus a 🤖 Quo note. Nothing it does
is customer-facing.

Three watchdog texts come from it:

| Text | Condition id | Means |
|---|---|---|
| `Quote drafter stuck on its run lock` | `quote-drafter:locked` | every tick for 15+ minutes found the run lock taken, so nothing drafts |
| `Quote drafter has no asset manifest` | `quote-drafter:no-assets` | there was work but the pricing ruleset / exemplars manifest is missing, so requests are consumed without a draft |
| `Quote drafter stopped` | `heartbeat:quote-drafter` | no tick has run for 20+ minutes (not texted while "locked" is already down) |

## How to check

1. System page, "Heartbeats and crons": "Quote drafter" row
   (`health:quote-drafter:ts`, stamped only by a tick that ran).
2. Redis `quote-drafter:skip`: JSON `{reason: 'locked' | 'no-assets',
   since, at, ticks}`, the current skip streak. Gone when the last tick ran.
3. Redis `quote-drafter:run-lock`: who holds the lock (value is
   `<ms>:<uuid>`, the time it was taken). It expires 15 minutes after it
   was taken.
4. Redis `quote-drafter:assets`: hash with `ruleset`, `sectionV`,
   `exemplars` (Blob URLs) and `updatedAt`. `ruleset` missing = no assets.
5. Mode and queue: `npx tsx tools/src/quote-trigger/mode.ts status`
   (prints the mode override, T4 mode, queue length, due phones, open
   quotes, heartbeat).
6. Worker logs in Vercel (aac-worker-monorepo) for `quote-tick` and
   `quote-draft`.

## How to fix

**Locked.** A quote-tick or a manual `/api/quote-draft` run is still going,
or keeps re-taking the lock. Look in the worker logs for a long run (both
routes have an 800s limit; the lock outlives that). The lock frees itself
15 minutes after it was taken; if the text keeps coming, something keeps
taking it. The runs release only their own lock (owner-checked), so
deleting `quote-drafter:run-lock` by hand while a run is live can let two
runs race on estimate numbers. Only delete it when the logs show nothing
running.

**No assets.** Republish the manifest from the repo root:

```
npx tsx tools/src/quote-trigger/sync-assets.ts
```

It uploads `analysis/data/quoting-spike/llm-ruleset.md` (required) plus the
Section V draft and exemplar library to Vercel Blob and rewrites
`quote-drafter:assets`. Needs `BLOB_READ_WRITE_TOKEN` in `.env.diagnostic`.
The condition clears once a draft goes through or the manifest is back.

**Stopped (heartbeat).** The cron isn't running or every tick 500s: check
aac-worker-monorepo in Vercel (cron runs, function errors, env vars, the
latest deploy). A tick in mode `off` doesn't stamp the heartbeat either,
so turning the drafter off also brings this text after 20 minutes; that
one is expected.

## How to switch it off

```
npx tsx tools/src/quote-trigger/mode.ts off      # stop drafting
npx tsx tools/src/quote-trigger/mode.ts shadow   # classify + log, no QBO writes
npx tsx tools/src/quote-trigger/mode.ts live
npx tsx tools/src/quote-trigger/mode.ts clear    # back to the QUOTE_DRAFTER_MODE env default
npx tsx tools/src/quote-trigger/mode.ts t4 off   # only the scope-change gate (default shadow)
```

The Redis override (`quote-drafter:mode`) wins over the env and needs no
redeploy. `off` short-circuits before touching the queue and clears the
skip streak.
