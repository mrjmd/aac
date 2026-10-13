# Triage Dashboard — Daily Gap-Closing Cockpit

**Status:** Iteration 1 built 2026-08-27 (local HTML + nightly launchd job).
**Owner surface:** `analysis/triage.html` (gitignored, local-only).
**Destination surface:** `apps/command-center` (blocked on audit remediation P0-5 — see Migration below).

## What this is

A nightly-regenerated, priority-ordered page answering one question: **what
gaps need closing today?** Ordered by Matt's explicit priority ladder
(2026-08-27):

1. **P0 — Booked-work gaps.** "Did I promise to schedule something that isn't
   on the calendar yet?" The scariest class — a customer thinks they're booked
   and nothing exists. (The Nancy Coleman class of miss.)
2. **P0 — Deal-closer responses.** Quote approvals that came in via text or
   call but were never scheduled; customer questions about an outstanding
   quote; anything where a reply likely closes a deal.
3. **P0 — Cash flow.** Jobs completed but never invoiced; invoices created but
   never sent; overdue AR in QB.
4. **P1 — Stale estimates.** Pending quotes that never got approved or closed.
   (Workflow for burning these down is still TBD — surfacing them is step 1.)
5. **P2 — Unresolved conversations.** Anything in texts, call transcripts, or
   email that looks like it's waiting on us.

This is the productized version of three designs that already exist in the
repo — it does not invent new architecture:

- `docs/command-center-spec.md` — "Business Pulse" metrics (outstanding
  invoices, stale estimates, approved-estimates-needing-scheduling) and the
  "Smart To-Do" AI commitment detection are exactly categories 1–4.
- `docs/projects/invoice-gap-audit-2026-08.md` — the exception-alert design
  (Calendar colorId 10 × Redis `field:completion:*` × QBO invoices) is
  category 3 verbatim. The audit's finding — *"the failure mode is silence"* —
  is this dashboard's reason to exist.
- `docs/projects/scheduling.md` — the shadow queue's `SchedulingDirective`s
  (`scheduling:pending:list` / `pending-review:list`) are machine-detected
  instances of categories 1–2 and are surfaced here alongside the raw sweeps.

## Why iteration 1 is local, not command-center

- `docs/projects/audit-2026-07-remediation.md` P0-5: command-center auth is
  presence-only (any cookie passes) and PLAN.md gates new feature work behind
  remediation Sessions A+B. Putting *more* owner financial data behind broken
  auth would be backwards.
- The local `analysis/` dashboard pattern already exists
  (`tools/src/analysis/build-dashboard.ts` → `analysis/dashboard.html`,
  self-contained HTML opened via `file://`, gitignored, creds from
  `.env.diagnostic`). Zero deploy surface, zero new attack surface.
- Fastest path to "something real to review" — Matt's ask.

## Iteration 1 architecture

```
tools/src/triage/
  collect.ts      # network pulls → analysis/data/triage/snapshot.json
  analyze.ts      # deterministic detectors + Gemini pass → findings.json
  render.ts       # findings → analysis/triage.html (self-contained)
  refresh.sh      # chains the three; safe to run manually any time
~/Library/LaunchAgents/com.aac.triage.plist   # 08:15 daily, opens dashboard
                                              # in browser; logs to
                                              # analysis/data/triage/refresh.log
```

Conventions follow `tools/src/analysis/`: cwd = repo root, `loadEnv()` from
`.env.diagnostic`, QB OAuth tokens read/written via Upstash REST (token
refresh MUST persist back — Intuit invalidates old refresh tokens), output
under gitignored `analysis/`.

### Data pulled nightly (collect.ts)

| Source | What | Via |
|---|---|---|
| Google Calendar | Events 60d back → 60d forward (id, summary, colorId, start/end, location) | `GoogleCalendarClient` (OAuth refresh token) |
| QuickBooks | Estimates + Invoices updated in last 180d (status filtered client-side — TxnStatus not queryable); all Customers, slimmed to id/name/normalized phones (joins QBO txns → Quo threads) | `QuickBooksClient` |
| Redis | `field:completion:{eventId}` for every calendar job; `scheduling:pending*` lists; `todo:list` | Upstash REST |
| Quo | Conversations active in last 21d → per-thread messages + calls; transcripts for completed calls ≥ 45s | `QuoClient` + direct REST for `/call-transcripts/{id}` (no client method yet — promote to `QuoClient` before any app uses it) |
| Gmail | Messages from last 21d (spam/trash/promotions/social/forums excluded), grouped into threads, machine senders (noreply/receipts/QBO/etc.) dropped; bodies get quoted-reply tails stripped and are capped at 1500 chars | `GmailClient` (same OAuth refresh token; needs `gmail.readonly` scope — degrades to a System card + `emailSweepError` in the snapshot when missing) |

Transcripts are cached in `analysis/data/triage/transcripts/` (immutable per
call id) so the nightly run only fetches new calls.

### Detectors (analyze.ts)

Deterministic first, LLM second; every finding carries evidence.

| # | Finding | Logic |
|---|---|---|
| D1 | Job done, not invoiced | Calendar colorId 10 ended > 18h ago; field completion missing or phase ≠ completed/cancelled; no QBO invoice fuzzy-matching customer name within job window. Distinguishes "field flow never finished" (the audit's root cause) from "flow done, invoice missing". |
| D2 | Invoice created, never sent | QBO invoice `EmailStatus = NeedToSend`, `Balance > 0` |
| D3 | Overdue AR | `Balance > 0` and `DueDate < today`, aged buckets (30/60/90) |
| D4 | Approved, not scheduled | Estimate `TxnStatus = Accepted`, no calendar event fuzzy-matching customer after (LastUpdatedTime − 7d). Cross-referenced with `scheduling:pending*` directives. |
| D5 | Stale estimate, nudge-aware | `TxnStatus = Pending`, TxnDate ≥ 3d old. Joined to Quo threads via QBO customer phones: no text/call in 3d+ (or no thread at all — i.e. quiet 21d+) ⇒ yellow "Nudge"; recently contacted ⇒ info with last-contact age. |
| D6 | Awaiting reply | Thread's last message is inbound and > 12h old |
| D7 | Missed call, no follow-up | Last call missed/no-answer with no later outbound message or completed call |
| D8 | Voicemail needs action | Last activity is an inbound voicemail (0s completed call, transcript via `/v1/call-voicemails/{id}`) with no reply since — yellow, evidence = transcript |
| D9 | Assessment done, no quote | Calendar colorId 3 ended ≥ 2d ago; no QBO estimate **or invoice** within (visit − 7d)→now matching by name or street tokens, and no green job event followed (same-day conversions). The window test uses the *latest* of TxnDate / LastUpdatedTime — a photo-based quote drafted weeks before the visit and revised after it counts (Lisa Martin #1501, 2026-10-03). Top-of-funnel gap D4/D5 can't see — they start from estimates that already exist. Red at 7d. Declined-on-site visits are dismissed by hand. |
| D10 | Stub never fleshed out | Any calendar event still titled `STUB — …` (Walk #7-lite auto-creation, `packages/scheduling/execute-stub.ts`). The prefix is the review marker — Matt confirms time/scope/duration and renames. Red when the slot is < 48h away or already past (a past stub also hides from D1/D4 name matching). Word-boundary match so surnames like "Stubbs" don't trip it. |
| D11 | Incomplete upcoming event | Work events (colorId 10/3/5) starting in the next 7 days missing an address (location), a description, or — jobs/callbacks only — Mike as attendee (`mike@attackacrack.com` or legacy gmail). Always red: Mike must have the full picture before rolling out (Shivani address incident, 2026-10-02). Assessments skip the attendee check (Matt runs some himself); STUB events are D10's; `[cont]` days inherit day 1. |
| D13 | Offered time on hold | `HOLD — {Name}` placeholders (execute-hold, see docs/projects/scheduling.md) parsed for `Offered-At:` + `Customer-Phone:`. Flags: customer replied but hold still standing (convert or release); slot passed unanswered (red — wasted inventory); unanswered ≥ 24h (yellow, red when the slot is < 48h out); hand-made hold without metadata (review). Case-sensitive `HOLD` match so "Hold in case …" soft blocks don't trip. Own section ("Offered times on hold") + pulse tile. |
| D14 | Agreed slot, no calendar event | Pending directives with an actionable slot (appointment_confirmed, or manual_schedule + booked, confidence ≥ 0.7) and no name-matched calendar event within ±1 day of the slot. Backstop for silent webhook kills mid-stub-creation (Vetrano incident 2026-10-12, see docs/projects/scheduling.md). Customer resolved via QBO id or phone; red when named, yellow when unresolved. Section `booked_gap`. |
| D12 | Email awaiting reply | Email thread's last message is inbound and > 12h old, surfaced only when L2 returned nothing for the thread (LLM failure fallback, mirrors D6). Info severity, evidence = last message excerpt, deep-links to the Gmail thread. |
| L1 | Commitment gap | Gemini (2.5-flash) reads each active thread digest (messages + call transcript excerpts) and flags: scheduling commitments by Matt, approval signals from customer, unanswered questions, promised follow-ups. Each claimed commitment is then checked against the calendar by name-token match; "no matching event" ⇒ P0. Two refinements (2026-10-03): **quote_promised** — Matt said a quote was coming and no QBO estimate followed (the prompt carries the last-60d estimate list, mirroring the calendar context) ⇒ own section high in the ladder ("that's deal flow" — Matt); **solicitation** — the other party is selling *to* Matt ("need more jobs?" lead-gen, SEO, robo-texts) ⇒ info card at the bottom with evidence shown, never a yellow "awaiting reply". |
| L2 | Email commitment gap | Same Gemini prompt (it carries the calendar + estimate context) over each email thread digest (subject, sender, last 12 messages, attachment names). Same categories/sections as L1; findings get an `✉` title prefix and a `link` to the Gmail thread. |

LLM output is JSON-schema'd, temperature 0; threads with zero activity and no
deterministic flag are skipped to keep the nightly Gemini bill trivial
(~60–100 flash calls). Per `[[ai-quality-gates]]`, LLM findings render with
their evidence excerpt and a confidence tag — never as bare assertions.

### Rendering (render.ts)

Single self-contained HTML (inline CSS, zero CDN), sections in priority
order, red/yellow/green per the command-center spec thresholds (invoice >30d
= yellow, approved-unscheduled >48h = yellow, etc.). Each item: customer,
phone (tel: link), dollars, age, evidence snippet, suggested next action.
Footer self-documents the regen command.

### Nightly task

launchd (`com.aac.triage`), StartCalendarInterval 08:15 (since 2026-09-29 —
morning-briefing mode: TRIAGE_OPEN=1 makes refresh.sh `open` the dashboard
in the default browser after refreshing, or immediately when findings.json
is already < 4h old). The old 05:30/07:00/08:30 catch-up ladder existed
because overnight fires landed in dark-wake windows with no network; at
8:15 the Mac is normally awake, and launchd fires a missed event once on
wake anyway. refresh.sh still retries network steps 3× with 90s backoff.
Manual runs (no TRIAGE_SCHEDULED) always do a full refresh and never
auto-open. NB: fire times are system-TZ local (this Mac: America/New_York,
verified 2026-09-29). Push notifications deliberately NOT included
(`[[no-proactive-notifications]]`): this is a pull surface. The one
sanctioned push (invoice-gap SMS cron per
`[[errors-as-diagnostic-agent-signals]]`) remains a separate,
middleware-side follow-up.

## Known gaps in iteration 1

- ~~**Email is not swept.**~~ Closed 2026-10-07: `GmailClient` added to
  `@aac/api-clients`, collect.ts sweeps the mailbox, L2/D12 triage email
  threads (quote requests were arriving by email and getting lost). One
  manual step remains: the diagnostic refresh token predates the
  `gmail.readonly` scope — run `npx tsx tools/src/scratch/reauth-google.ts`
  (scope added there) and paste the new `GOOGLE_REFRESH_TOKEN` into
  `.env.diagnostic`. Until then the sweep degrades to a yellow System card.
- **Name matching is fuzzy.** QBO customer ↔ calendar summary ↔ Quo thread
  joins are token-based; expect some manual dismissals at first. The Redis
  linkage (`field:completion` keyed by calendar event id, scheduling
  directives keyed by QB estimate id) is exact where it exists.
- **Dismissals are file-edited, not clickable.** Owner-curated suppressions
  live in `analysis/data/triage/dismissals.json` (added 2026-09-03):
  `{ match, sections?, reason, addedAt }`, matched case-insensitively against
  finding customer/title/phone in analyze.ts after all detectors run. Pulse
  counts are recomputed post-dismissal. First entries: Forristall (hostile,
  job done), Donna Souza (couldn't help), Ishman Williams (canceled via
  voicemail). No UI to add/remove yet — edit the JSON.
- **Voicemails ARE retrievable: `GET /v1/call-voicemails/{callId}`**
  (docs: quo.com/docs → Calls → "Get a voicemail for a call"; verified live
  2026-09-03 with a full transcript + recording URL). Note the path — it is
  NOT under `/v1/calls/{id}`, `/v1/call-transcripts`, or `/v1/voicemails`,
  which is why an endpoint-guessing sweep missed it: **check the docs before
  concluding an API can't do something.** Detection: ANY incoming call with
  `duration 0` may carry a voicemail — measured 2026-09-03, 30 of 31 were
  status `no-answer` and only 1 `completed`, so the probe must not gate on
  status (404 = rang out, cached as a negative). collect.ts fetches + caches these
  (`transcripts/vm-{callId}.json`), threadDigest feeds them to L1, and D8
  flags an unanswered voicemail as a yellow conversation finding. Promote
  the fetch into `QuoClient` before any app uses it (same rule as
  transcripts).
- **Cash/check payments** can look like open AR in QBO (audit caveat) —
  D1/D3 findings say "confirm with Mike before dunning anyone."

## Migration path → command-center

Once remediation P0-5 (real session verification) lands:

1. Promote transcript fetch into `QuoClient`, detectors into a package (or
   `apps/command-center/lib/triage.ts`), reusing the same finding shapes.
2. Findings write to Redis as to-dos (`source: 'ai-detected'` — the model
   already exists in `lib/todos.ts`), fulfilling the spec's "to-do stays
   until the job appears on Google Calendar" rule.
3. Nightly generation moves to a Vercel cron; the local launchd job retires.
4. The "Business Pulse" placeholder card becomes the summary header of this
   page.

## Open questions

- Stale-estimate workflow: surface-only for now. Burn-down process (LLM-drafted
  personalized nudges per `[[llm-personalized-outbound]]`? explicit
  close-lost sweep?) to be designed with Matt once he's looked at the list.
- Threshold tuning: 18h invoice lag, 12h reply lag, 14d stale — all constants
  at the top of `analyze.ts`, adjust after a week of real use.
- Whether D1 should also SMS Matt (the audit doc wants it) — deferred until
  the dashboard proves signal quality; avoids alert fatigue on day one.
