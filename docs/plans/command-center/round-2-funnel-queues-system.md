# Command Center, Round 2: Queues, Funnel, Seasonal Scorecard, Deep System Health (2026-11-02)

Companion to `README.md`. Captures Matt's second round of asks after the first mockup, plus the research ideas we haven't used yet. Brainstorm stage: nothing here is built, and the open questions in §8 need answers first.

## 0. The one idea that ties it together

Matt's four asks (expand into "all quotes to send", a funnel showing where we're stuck, a seasonal scorecard, deep automation health) are one model seen from four sides:

| Concept | What it is | Example |
|---|---|---|
| **Stage** | Where a customer/job is in the lifecycle | "Quote sent, awaiting decision" |
| **Queue** | Everyone currently in a stage (the full population) | All 14 open quotes, \$24.6k |
| **Item** | An *exception* inside a queue that needs Matt | Quote #1561, day 14, quiet 9 days |
| **Funnel** | Queues in sequence, with flow rates and time-in-stage | 92 leads → 54 assessed → 71 quoted → 41 won |
| **Scorecard** | Periodic snapshots of funnel flow vs (seasonal) goals | Quotes sent this week: 6 vs goal 7 (Nov-adjusted) |
| **System health** | The same idea for automations: runs flow through, checks are invariants, failures are items | "Every new Quo number gets a PD person within 5 min" |

The backbone this implies is a **lifecycle ledger**: for every customer/job, the timestamp they entered each stage. Queues are "current stage = X". Funnel conversion and time-in-stage come straight from the timestamps. Scorecard rows are counts of stage entries per week/month. Today's detectors become "time in stage > threshold" or "invariant broken" rules on top of it. **Recommendation: the ledger becomes a Phase 1 foundation**, built alongside the item system, because everything else in this doc reads from it.

---

## 1. Research ideas worth adopting (not yet in the plan)

From `research-dashboard-ux.md`. Already adopted: New band, sacred order, dismiss-with-reason, confirm lane, snooze-until-reply, ⓘ definitions. The rest, ranked:

1. **"Count + \$ + click to the filtered list" (Housecall Pro Open Items).** This *is* Matt's expand-into-all-of-one-type ask. Every queue shows as a tile (count, \$, oldest), and the tile opens the full list. See §2.
2. **"Missed" revenue (ServiceTitan).** Put a \$ value on leakage at each funnel stage (unanswered leads, assessments never quoted, quotes that died). This turns "where's our problem" into dollars. See §3.
3. **Same period last year (Housecall Pro / ServiceTitan).** The simplest seasonality fix. Show it beside every volume number. See §4.
4. **"→ a date", not just "→ Today" (Things 3).** On This week, drag an item onto a day column to schedule it for that day. It shows up on Today when the day arrives. This fits the day strip naturally.
5. **A short Monday planning ritual (Sunsama daily planning, EOS weekly meeting).** This week becomes a 10-minute guided pass: last week's scorecard → the funnel's biggest leak → open slots → pull forward what matters → done. Optional, never nagging (no notifications).
6. **Cap and expire AI insight cards (Shopify).** At most 3 AI "insights" a day (e.g. "close rate on Ads leads dropped"), each expiring after 24h. Quiet days are success.
7. **Every number says which date it counts by (ServiceTitan ⓘ).** Already planned. It matters more now: funnel stages mix call end time (PD, UTC), estimate TxnDate, calendar start, and payment date.
8. **Name the top 3 (Jobber).** Queue tiles name the worst offenders ("oldest: Arnaud 16d, Lyons 45d"), not only a count.

---

## 2. Queues: expand into "all of one type"

### Concept
Every item has a class (its detector or kind). Every class belongs to a **queue**, and the queue is the *full population* in that state, not just the flagged ones. "Quotes to send" lists every promised-but-unsent quote, bot draft awaiting review, and estimate created but never emailed. The ones that are overdue get flagged at the top. From any item, a "See all 7 →" link opens its queue. Area pages become mostly their queues as tiles.

### Queue page anatomy
- Header: count, \$ total, median age, oldest; flow over the last 7 days (in / out); trend sparkline.
- Table with class-specific columns (see catalog), sortable, saved filters (e.g. "MA only", "Ads leads").
- Flagged rows on top, with the item verbs (Done, Snooze, Dismiss, → Today, → day).
- Bulk actions: snooze/dismiss many, open all drafts, "→ Today: top 3".
- Every row opens the drawer and the Customer page.
- URL per queue (`/q/quotes-to-send`) so it's bookmarkable from a phone.

### Draft catalog (what exists today in parentheses)

| Area | Queue | Key columns | Source / today |
|---|---|---|---|
| Sales | **Conversations needing a reply** (texts + email) | who, phone, channel, last inbound, hours waiting, AI summary, draft ready? | Quo + Gmail (D6, D7, D12, L1, L2) |
| Sales | New leads, no next step | source, first contact, replied?, next step | PD + Quo (partly L1) |
| Sales | Assessments to schedule / scheduled | address, requested times, slot offered | Calendar + scheduling dispatch |
| Sales | Assessed, no quote | assessment date, days since | D9 |
| Sales | **Quotes to send** | promised when, bot draft status, \$ | L1 quote_promised, quote drafter, QBO EmailStatus |
| Sales | Quotes awaiting decision | \$, age, follow-up stage, last touch, opened? | QBO Estimates + stale-quote runner (D5) |
| Sales | Accepted, not scheduled | \$, accepted when, suggested slot | D4 |
| Jobs | Holds and stubs to confirm | event, offered when, reply? | D10, D13, D14 |
| Jobs | Upcoming events missing info | what's missing | D11 |
| Jobs | Done, not invoiced | job date, tech | D1 |
| Money | Invoices to send | \$, created | D2 |
| Money | Receivables by age | \$, days, reminders sent | D3 |
| Money | Undeposited payments | \$, collected by, days | recon plan |
| Money | Recon exceptions | txn, issue | recon plan |
| Marketing | Reviews to answer | rating, text | new |
| Admin | Obligations, COI requests | due, owner, evidence | new |
| Commercial | Bid leads | fit, gates, due | new |
| System | Automation problems | automation, check, since | §5 |

Note: the sales queues in order *are* the funnel stages. That's deliberate.

---

## 3. Funnel: where's the problem?

### Stages (draft)
```
Lead in ─► First reply ─► Real lead ─┬─► Assessment booked ─► Assessed ─┐
                                     └─► Photo quote path ──────────────┴─► Quote sent ─► Accepted ─► Scheduled ─► Done ─► Invoiced ─► Paid ─► Deposited
                                                                                                                                  └─► Review / referral
```
Two paths matter: photo quotes skip the visit, and their close rate and speed probably differ.

### What it measures per stage
- **Conversion** to the next stage (and drop-off).
- **Speed**: median and p75 time in stage (first reply, assessment-to-quote, quote-to-decision, done-to-paid).
- **Work in progress + aging**: how many are sitting there now, and for how long (= the queue).
- **Leakage \$**: drop-off × downstream conversion × average ticket ("Missed").
- **Cut by source/channel** (Google organic, Ads, referral, Ed/realtors), which feeds CAC on Marketing.
- **Cut by path** (photo vs visit), state (MA/CT), and service (injection vs resurfacing).

### Visualizing the funnel (Matt wants a strong visual)
Options, from most to least central:
1. **Flow funnel (primary).** Stage bars left to right, width = count (toggle to \$). Between bars: the conversion % and median days. Drop-offs peel away as red streams labeled with where they went (ghosted, lost, declined, went stale). The same period last year shows as a ghost outline behind each bar, so a shrinking stage jumps out. It splits at the photo-quote vs assessment branch and rejoins at "Quote sent".
2. **Source-to-outcome flow (Sankey).** Lead sources on the left (organic, Ads, referral, Ed/realtors, other) → path → won / lost / still open on the right. Answers "which channels turn into money," and pairs with CAC on Marketing.
3. **Stuck board (live).** A column per stage, a dot per customer, dot size = \$, color = age vs that stage's normal (green, amber, red). This is "where things are stuck right now". Clicking a column opens its queue, and clicking a dot opens the customer.
4. **"Where's the problem" waterfall.** The revenue change vs last year as a waterfall: leads, real-lead rate, quote rate, close rate, average ticket. The biggest bar is the answer.
5. **Speed curves.** "% of leads quoted within N days" and "% of quotes decided within N days", this period vs last. Shows whether things are speeding up or slowing down.
6. **Cohort river.** Leads grouped by the week they arrived, stacked by where they are now. Shows how fast each week's leads mature, and makes a stall obvious.

Recommendation: 1 is the hero of the Funnel view, 3 sits beside it as the live view, and 4 is the readout. 2, 5 and 6 go one click deeper.

### "Where's our problem" readout
Revenue is a product: **leads × real-lead rate × quote rate × close rate × average ticket**. Compare each factor with its own baseline (same months last year, or trailing average) and split the revenue change into each factor's contribution (log decomposition). The readout is one sentence plus a bar chart:

> Revenue is 18% under last October. Leads −25% explains −\$9.1k. Close rate +4% adds +\$1.2k. Average ticket +3% adds +\$0.8k. **The problem is lead volume.**

A second view tests speed: close rate by first-reply bucket (< 15 min, < 1h, < 4h, later) from history. That answers whether responding faster actually wins more for AAC, or whether it already doesn't matter at current speeds.

### Learning loop
Each stage keeps a **change log** (pricing policy 10/27, stale-quote drafts going live, the quote drafter, Ads changes), shown as markers on the stage's trend. Then "did the 10/27 pricing change move close rate?" can be read off the chart instead of guessed. This is the "learn how to improve each step" part.

### Where it shows
- Sales area: a **Funnel** sub-view (full detail, cuts, decomposition, change markers).
- This week: last week's flow (how many moved through each stage) next to the scorecard.
- This month: the decomposition readout ("the problem is X").
- Scorecard rows link to their funnel stage.

### Data reality (needs the spike, §7)
- "Real lead" needs a firm definition: excludes solicitations, spam, existing customers re-texting, Ed's internal line.
- Attribution source of truth is Pipedrive; PD timestamps are call **end** time in UTC; GA4 was Pacific until 2026-04-02.
- Quotes live in QBO Estimates, and TxnStatus isn't queryable, so filter client-side.
- Assessments are calendar colorId 3. Name matching drifts (`[cont]`, misspellings, realtor-paid jobs).
- \$ from QBO is unreliable for 2026 until the books are fixed. Counts and rates are fine; revenue factors need the caveat.
- The 2026 marketing cut (~80%) is a real confounder for year-over-year lead comparisons. The readout has to show it as a change marker, not hide it.

---

## 4. Scorecard: weekly and monthly, seasonally fair

### Both cadences
- **This week**: the 13-week grid (kept, as Matt asked).
- **This month**: the same rows as monthly columns, 13-18 months, with the same month last year beside each one.

### Seasonality: three options, recommend the hybrid
1. **Same period last year.** No model, easy to explain, but noisy and confounded (2026 marketing cut, the Beacon conversion).
2. **Seasonal goals.** Compute a seasonal index per month from history (month average ÷ yearly average, smoothed toward 1 because there are only ~2.5 seasons of data, interpolated to weeks, with holiday weeks marked). Matt sets **one annual goal per row**; the system derives each week's and month's target: `target = annual goal ÷ 52 × index`. February is judged against a February-sized goal.
3. **Hybrid (recommended).** Seasonal targets for **volume** rows (leads, assessments, quotes, jobs, revenue, collected). Flat goals for **rate/speed** rows (close rate, reply time, days to invoice), since those shouldn't depend on season. Show last year as a grey reference.

### Seasonally adjusted run-rate
One extra number on This month that matters for the charter: **actual ÷ seasonal index = what this month is "worth" in average-month terms**. Example: "October \$35k is a \$41k average-month equivalent." That says whether December's dip is normal winter or a real decline, months before the Mar-May 2027 decision window. It also helps the tech #2 winter-multiplier gate.

---

## 4a. Metrics catalog (pick from this)

Tags: **W** = weekly scorecard candidate, **M** = monthly scorecard candidate, **A** = lives on an area page. **Lead** = leading (predicts), **Lag** = lagging (confirms). Volume rows get seasonal targets; rates and speeds get flat goals (§4).

**Demand**
- Real leads in, total and by source · W M · Lead
- Cost per lead, by channel · M A
- Missed calls with no follow-up within 2h · W · Lead
- Lead mix: MA/CT, injection vs resurfacing, repeat/referral share · M A

**Speed**
- First reply time, p50/p75 (business hours) · W · Lead
- Lead → assessment booked, days · M A
- Assessment → quote sent, days · W · Lead
- Quote → decision, days · M A
- Accepted → on the calendar, days · M A
- Booked weeks out (backlog in time) · W · Lead
- Done → invoiced, hours · M A
- Invoiced → paid (DSO), days · M
- Paid → deposited, days · W (until the field-app deposit gap is closed)

**Conversion**
- Lead → quote sent % · M
- Close rate by count and by \$ (they differ: big jobs close less often) · W (trailing 4 weeks) M
- Close rate: photo path vs visit path · M A
- Close rate by source · M A
- Close rate by quote size bucket (< \$1.5k, \$1.5-3k, \$3-6k, > \$6k) · A
- Follow-up recovery: quotes won after at least one follow-up · M A

**Dollars and deal size**
- \$ quoted · W M · Lead
- \$ won (bookings: accepted quotes) · W M · Lead
- Revenue (\$ completed/invoiced) · M · Lag
- Collected · W M · Lag
- Average quote size · M
- **Average won deal size** · W (trailing 4 weeks) M
- Average ticket by service (injection, resurfacing, bulkhead, etc.) · A
- Discount rate: \$ discounted ÷ list price (ties to the pricing policy and anchor drift) · M A
- Quote-to-invoice change: did the final bill differ from the quote (scope creep or under-quoting) · M A

**Pipeline**
- Open pipeline \$, weighted by the odds of closing at that age · W M · Lead
- Backlog \$: booked, not done yet · W · Lead
- Expected bookings, next 30 days · M · Lead

**Capacity and job economics**
- Mike's utilization: booked hours ÷ available · W
- Jobs completed · W M
- Revenue per tech-day · M
- Gross margin per job (materials + labor) · M · Lag
- Duration estimate accuracy: estimated vs actual hours · A
- Callback (rework) rate · M · Lag

**Cash**
- AR over 30 days · W M
- Undeposited \$ and oldest days · W
- Cash on hand in months of expenses · M
- Tech #2 vault progress · M

**Marketing efficiency**
- Spend, total and by channel · W M
- CAC by channel and blended · M
- Ads return: revenue from Ads leads ÷ Ads spend · M
- Payback: months for a customer's margin to cover their CAC · A
- Reviews: new count, rating, and requests sent → reviews earned · M

**Customer**
- Repeat customer rate · M
- Referral rate: leads that came from past customers · M

**Owner and leverage** (the charter's objective)
- Owner take-home · M · Lag
- Owner hours/week (source to be decided) · W M
- Automation leverage: drafts sent unedited %, bot quotes sent unedited % · M A

**Suggested starting scorecard (Matt to edit)**
- Weekly (12): real leads, first reply p75, missed calls unanswered, quotes sent, \$ quoted, \$ won, close rate (4-week), average won deal (4-week), booked weeks out, jobs completed, collected, undeposited \$.
- Monthly (15): the weekly volume rows as monthly totals, plus revenue, seasonally adjusted run-rate, gross margin, average ticket by service, discount rate, CAC blended, AR over 30, owner take-home, repeat + referral rate.

---

## 5. System: deep health for every automation

### Inventory (audited 2026-11-02)
| Where | Automation | Trigger |
|---|---|---|
| Middleware | Quo webhook (contact sync, scheduling dispatch, quote-trigger enqueue, stub events) | webhook |
| Middleware | Pipedrive webhook (contact sync to Quo/QBO) | webhook |
| Middleware | QBO webhook (CloudEvents) | webhook |
| Middleware | Google Ads webhook | webhook |
| Middleware | Scheduling send-proposal / proposal-decision | API |
| Middleware | Enrich | API |
| Middleware | invoice-create | cron 11:00 UTC |
| Middleware | job-reminders | cron 12:00 UTC |
| Middleware | job-followups (review prompts) | cron 13:00 UTC |
| Middleware | deal-reconcile | cron 14:00 UTC |
| Middleware | qb-reconcile (acceptance notes) | cron every 30 min |
| Middleware | QBO OAuth (refresh lock) | on demand |
| Worker | tick (message drafts) | every min |
| Worker | quote-tick (quote drafter trigger loop) | every min |
| Worker | quote-email-tick | every 15 min |
| Worker | sweep | every 10 min |
| Worker | draft-followup, quote-draft (manual) | API |
| Laptop | triage (08:15), message-drafts backstop | launchd |
| Planned | weekly recon, Friday deposit reminders, commercial agent | cron |

Existing raw material: `keys.heartbeat(app)`, `keys.webhookCount(source, date)`, `keys.webhookLast(source)`, `keys.healthErrors`, `keys.webhookAuditStream`, the Gemini canary, triage D14/D15.

### Six layers of health per automation
1. **Alive**: ran on schedule (last success vs expected cadence).
2. **Healthy**: error rate, retries, p95 latency vs its time limit (the 10/12 timeout and the 10/19 Quo webhook auto-disable were both latency problems), queue depth and oldest age.
3. **Correct (outcome checks)**: the important, new layer. Assertions that the automation *did the right thing*, checked end to end:
   - every new Quo number has a PD person within 5 min, mapped both ways;
   - every PD person has exactly one Quo contact (no duplicates; remember the externalIds incident);
   - every completed job has an invoice within 24h, and every created invoice was emailed;
   - every next-day job got a reminder; every finished job got its follow-up;
   - every chat booking produced a stub event;
   - every QBO acceptance got its note within 30 min.
   Several triage detectors (D1, D14, D15) are already outcome checks in disguise.
4. **Quality (AI parts)**: bot quote sent-unchanged rate, draft send rate, classifier disagreement, Gemini canary.
5. **Dependencies**: OAuth token expiry and scopes (Google, QBO), Quo webhook still enabled, Gemini prepay balance, Pipedrive API deprecations, rate-limit headroom, deployed version and feature-flag state per app.
6. **Volume anomalies**: today's events vs the usual for this weekday and hour. Silent failures show up as missing volume (a disabled Quo webhook reads as zero events, not an error).

### Page design
- **Overview**: one status line ("21 of 23 healthy, 2 need a look"), then automations grouped by business flow (Lead intake, Scheduling, Quoting, Invoicing and payments, Follow-ups, Sync, Dependencies), each a card: status, last run, runs/24h, errors, p95, last outcome check.
- **Automation detail** page: what it does in plain English, trigger and schedule, flags, a run timeline, outcome-check history, recent errors with the diagnostic agent's diagnosis and proposed fix, records it touched (linked), a runbook ("if this fails…"), and the code path.
- **Changes feed**: deploys and flag flips on the same timeline, since most incidents follow a change.
- Failures become **items** in the System area. Only P1 problems auto-promote to Today. Texting stays reserved for exceptions via the diagnostic agent (`[[errors-as-diagnostic-agent-signals]]`).

### How to build it without touching middleware much
- An **automation registry** (one typed file): id, name, plain description, trigger, cadence, expected volume, code path, checks. It doubles as documentation.
- A shared, unit-tested `withRun()` wrapper in `@aac/shared-utils` that records start/end/status/counts/error/version to a run stream (keys defined in shared-utils). Middleware changes are limited to wrapping handlers with it, one tested change at a time.
- **Outcome checks run in the worker, read-only**, never in middleware. Middleware stays sacrosanct.

---

## 6. What changes in the main plan
- Phase 1 adds the **lifecycle ledger** (stage timestamps per customer/job) next to the item system, plus the automation registry and `withRun()`.
- Area pages become **queue tiles + queue pages** rather than bespoke detail panels.
- Phase 2 Sales gets the **Funnel** sub-view; scorecard work includes **seasonal targets** and the **monthly scorecard**; System becomes the deep page.
- Storage: the ledger, run history, and seasonal history are relational and historical. This strengthens the case for Turso (README §11, decision 5).

## 7. Next steps (in order)
1. **Funnel + seasonality data spike** (read-only, analysis only, about a day). Backfill the lifecycle ledger from 2024-2026 data (Quo, PD, QBO estimates/invoices, calendar). Produce real stage counts, conversion, time-in-stage, close rate by reply speed, monthly seasonal indices, and a first "where's the problem" decomposition. Also compute a baseline for every metric in §4a the data supports (and flag the ones it can't), so the scorecard rows get picked against real numbers. Output to `analysis/02-strategy/funnel-baseline-2026-11.md`. This answers Matt's question with real numbers now, tests whether the stage definitions hold up against messy data, and gives the mockup real-shaped numbers.
2. **Automation inventory + check catalog**. Walk every automation in the table above, write the draft registry, list the outcome checks each needs, and mark which can run today from existing keys vs which need `withRun()`.
3. **Mockup round 3**: the flow funnel + stuck board + waterfall, one queue page (Quotes to send) and Conversations needing a reply, the Funnel view with the decomposition, the monthly seasonal scorecard, System overview + one automation detail page, and "→ day" drag on This week.
4. **Matt's decisions** (§8), then fold everything into `README.md` and re-sequence the phases.

## 8. Open questions for Matt
1. **Stage definitions**: what counts as a "real lead"? Is the photo-quote path its own branch? Does "Done" mean the field app completion or the calendar day?
2. **Seasonality**: OK with the hybrid (seasonal targets for volume, flat goals for rates, last year shown in grey)? Set one annual goal per row?
3. **First queues**: which 3 do you want first? Suggest Conversations needing a reply, Quotes to send, Quotes awaiting decision.
4. **Monday planning ritual**: want the guided 10-minute pass on This week, or keep it free-form?
5. **Scorecard rows**: start from the suggested 12 weekly / 15 monthly in §4a, or edit after seeing the baselines from the data study?
6. **System scope**: is "outcome checks" (did it do the right thing) the priority, ahead of uptime/latency dashboards? (Recommended.)
