# Plan: Command Center v2, the Owner's Operating System

**Date:** 2026-11-02 · **Status:** DRAFT for Matt's review. Nothing gets built until the open decisions at the bottom are answered and the wireframe pass is done.
**Supersedes (on approval):** `docs/command-center-spec.md` (2026-03-31 card-grid spec). Absorbs the migration section of `docs/projects/triage-dashboard.md`, the dashboard pieces of `docs/plans/weekly-recon-and-deposit-reminders.md`, and the "Important Dates" idea from `docs/meta-architecture.md`.
**Research behind this plan (same folder):**
- `research-dashboard-ux.md`: Jobber, Housecall Pro, ServiceTitan, Shopify, QBO, Linear, Things, Sunsama, EOS, Stephen Few, NN/g
- `research-compliance.md`: every recurring filing/license/insurance obligation, COI workflow, prequal packet, tracker data model
- `research-commercial-bids.md`: MA bid platforms, public bidding law, crawl/walk/run for commercial

---

## 1. What this is for

One place Matt opens to run the business. It answers three questions in this order:

1. **What do I need to do today?** (action)
2. **Are we on track this week?** (leading measures)
3. **Are we on track for May 2027?** (the charter's decision: \$50k/mo floor, \$80k + tech #2 + fewer owner hours aspirational)

Everything else is a drill-down. If a screen doesn't help answer one of those, it doesn't ship.

**Success test:** Matt stops opening `triage.html`, QBO's dashboard, Pipedrive, and his own memory for deadlines, because this is faster and more complete. Measured by: triage.html retired; zero missed filing/renewal deadlines; the monthly scoreboard exists every month without effort.

---

## 2. Where we are today (audited 2026-11-02)

| Surface | Reality |
|---|---|
| `apps/command-center` | **Never deployed** (no Vercel project, no deploy script). Last real UI work May 29. Typechecks clean. Has login, sidebar, `@aac/ui`, Redis wiring, a scheduling-directives view, health page, manual todos. Home has 2 live cards and 5 "Coming soon" placeholders. **Auth is broken** (audit P0-5, still open): middleware checks cookie *presence* only, `verifySession()` has zero callers, any cookie reads financials and edits todos. |
| `analysis/triage.html` | The real daily driver. 2,600 lines in `tools/src/triage/`, runs on the laptop via launchd 08:15. Detectors D1-D15 + L1/L2 across calendar, Quo, QBO, Gmail. Dismissals are hand-edited JSON. Can't persist clicks, can't be opened from the phone. |
| `analysis/dashboard.html` | One-off business diagnostic (10/20), built on the broken 2026 books. |
| `analysis/commissions.html` | Ed commissions. Counts commission on undeposited checks (fix in the recon plan). |
| `analysis/03-scoreboard/` | **Empty.** Charter calls the monthly scoreboard "non-negotiable"; six months missed (blocked on broken books, now being fixed). |
| `apps/marketing` | Spike 4.0 content pipeline with its own UI + auth (byte-identical auth lib). |
| Compliance/deadlines | Lives in Matt's head, Gmail, and one-off memory notes (Kinsale renewal 10/13, GL audit dispute due 11/16, rebrand ledger doc 18). No system. |

**What carries forward from the March spec:** the core instincts were right (Business Pulse, Smart To-Do with AI commitment detection, Important Dates, full-funnel attribution, Gmail monitoring). Triage already delivered the commitment detection and Gmail monitoring locally. What changes is the **shape**: a grid of seven equal cards becomes an action-first Overview plus area pages, and to-dos become a first-class item system with real state.

---

## 3. Information architecture

### 3.1 Top level

```
Overview          home: Today / This week / This month
Sales             leads -> assessments -> quotes -> won; quote drafts; stale quotes; partners/Ed channel
Jobs              schedule, stubs/holds, field completions, Mike's week, callbacks, capacity
Money             cash by account, AR, deposits + weekly recon, P&L, margin, take-home, commissions, tech #2 vault
Marketing         spend by channel, CAC trend, lead sources, reviews, website/ads; later: content production
Admin             obligations calendar, insurance + COIs, documents vault, entity/rebrand checklist
Commercial        (later) bid pipeline: found -> pursuing -> submitted -> won/lost; prequal packet
System            (small, bottom of nav) middleware/worker health, cron heartbeats, token expiry
```

Plus one cross-cutting page that every item links to:

**Customer** (`/c/{id}`): one timeline per customer across Quo texts/calls/voicemails, emails, QBO estimates/invoices/payments, calendar events, field photos, Pipedrive attribution. Today, reconstructing "what's going on with this person" means five tabs. This page makes every item one click from full context. It's the highest-leverage single screen after Overview.

**Why these areas:** they map to the business's real loops (get demand, convert it, do the work, get paid and keep the books true, stay legal) rather than to data sources. "Triage" stops being a page: it becomes the engine that feeds Overview, and each area page shows its own slice of items.

### 3.2 Overview: three views of one page

Daily/weekly/monthly live **inside Overview**, as Matt suggested, as segmented tabs (Today is default).

**Today** (operational; one screen; phone-first)
```
┌ Today, Mon Nov 2 ──────────────────────────── cash $xx,xxx · booked 1.4 wks ┐
│ Jobs today: 8:00 Smith (inject, Quincy) · 1:00 Lee (assessment, Milton)     │
├ NEW SINCE YOU LOOKED (3) ── place or dismiss ───────────────────────────────┤
│ ● Kshitij Bichave replied "finished basement" · quote #1576 may be stale   │
│ ● COI request from Boston Mgmt (email) · due Wed                           │
├ MY ORDER ────────────────────────────────────────────── drag to reorder ─────┤
│ 1 ▸ Call Jill re Hobart Unit 39 quote (overdue 3d)           [done][snooze]│
│ 2 ▸ Deposit: Dacey check $975, 9 days undeposited   💲 confirm to dismiss   │
│ 3 ▸ Stub needs review: Vetrano Thu 8am                                      │
├ AUTOMATION DID THIS, CONFIRM ───────────────────────────────────────────────┤
│ 2 follow-up drafts ready · 1 bot quote draft · recon: 14 txns to approve   │
└ Coming up: MA annual report due Nov 19 · Kinsale audit payment Nov 16 ─────┘
```

**This week** (the 7-day horizon: what's coming, what to get ahead of, what's open, how the weeks are trending)
- Day-by-day strip for the week: calendar events, open half-days (capacity to fill), and every item due that day (COI due Wed, hold expiring, quote hitting day 14, a promise like "I'll call Thursday", Friday payroll and deposits). Items already on Today are marked.
- **Get ahead of**: this week's items not yet on Today, sorted by day, each with "→ Today". This is where Matt pulls things forward (the stale-quote case).
- **Open slots, and what could fill them**: each open half-day matched against accepted-not-scheduled and likely-to-accept quotes, with a one-tap scheduling draft. Demand is the constraint, so open time is shown first.
- Next week peek (deadlines and site walks 8-14 days out).
- **EOS-style scorecard** (Matt wants it here): 8-12 measurables as rows, last 13 weeks as columns, a goal per row, red/green with text. It's for reading trends, so cells don't turn into items.
- Monday recon status and the week's deposit picture live here.
- Draft measurables (Matt picks): real leads in · p75 first-reply time · assessments done · quotes sent · \$ quoted · close rate · booked weeks out · jobs completed · \$ invoiced · \$ collected · AR > 30d · undeposited \$ · reviews earned · marketing spend.

**This month** (analytical; the May 2027 view)
- The **Critical Number** (one number the year is about; see decisions) with trend vs the \$50k floor and \$80k target, as a rolling 3-month average, since that's exactly how the charter measures May 2027.
- Charter tracker: floor, aspirational, tech #2 gates (winter 1.5x multiplier, \$60-70k vaulted), owner hours trend.
- 3-5 quarterly priorities ("rocks") with status.
- Long trends (18 months monthly), same-month-last-year comparisons (seasonal business).
- Generates `analysis/03-scoreboard/YYYY-MM.md` automatically, so the charter's file requirement is met as a byproduct.

### 3.3 Area pages

Each area page has the same skeleton, so learning one teaches all of them:
1. **Needs attention**: this area's open items (same item component as Today, with "→ Today").
2. **Numbers**: 4-6 tiles, each "count + \$" that clicks through to the filtered record list (Housecall Pro pattern). Every number has an ⓘ: definition, source system, which date field.
3. **Detail**: lists, trends, the area's specific tools.

---

## 4. The item system (the core of the whole thing)

Everything actionable (triage findings, recon flags, deposit gaps, stale quotes, customer promises, filing deadlines, COI requests, bid opportunities, manual to-dos) is one **Item**. One model, one component, one set of verbs. This is what makes "promote from weekly to today" and "dismiss as noise" work everywhere.

### 4.1 Verbs and states

| Verb | Meaning | State stored | Comes back when |
|---|---|---|---|
| **Done** | I handled it | `done`, timestamp | Detector sees the *same* problem with new evidence (e.g. new inbound after you replied) |
| **Snooze** | Not now | `snoozed`, until-time | The time passes **or** new evidence arrives, whichever first (Linear) |
| **Dismiss** | This one is noise | `dismissed`, one-tap reason (not real / already handled / not mine / wrong match / other), evidence fingerprint | Only on *material* change vs the stored fingerprint |
| **Mute** | This *kind* is noise | a rule (detector + match, e.g. "D6 for Forristall", "solicitations from X") | Never, until un-muted in Settings |
| **→ Today** | Promote | `pinnedFor: date`, rank | n/a |
| **Reorder** | My priority | explicit `rank` on Today | n/a |

Rules that make this trustworthy:
- **Matt's order is sacred.** Automation never reorders "My order." New items land in the **New since you looked** band at the top; Matt places or dismisses them. (Motion's auto-reshuffling is the documented anti-pattern.)
- **Money and legal items ask for a confirm before Dismiss or Mute** (undeposited payments, AR, filing deadlines, insurance, COIs). Matt may have handled one somewhere the system can't see, so it's never a hard lock.
- **Every dismissal can be undone.** Dismissed items go to a "Dismissed, last 30 days" list (Today and Rules) with Restore; mutes are undone on Rules.
- **Dismiss reasons feed the detectors.** Replaces hand-edited `dismissals.json`; "wrong match" counts tell us which joins to fix.
- **Rollover pressure.** An item on Today 3 days running gets flagged: do it, schedule it, or let it go.
- **Two lanes:** "Needs you" vs "Automation did this, confirm" (message drafts, bot quote drafts, recon categorizations, deposit-reminder dry runs). Keeps review work from drowning action work (QBO Business Feed pattern).
- **Evidence always attached** (existing triage rule from `[[ai-quality-gates]]`): every item shows why it exists and links to the Customer page or source.
- **Quiet days are success.** No filler. P0 items always show; lower tiers can be capped.

### 4.2 Promotion and escalation

- **Manual:** any item on any page has "→ Today" (or "→ date", Things-style: it flows into Today when the date arrives).
- **Automatic** (few, explicit, listed in Settings so they're never mysterious):
  - deposit still outstanding Friday noon → Today
  - filing/renewal at T-7 days → Today (T-30 shows on Admin + "Coming up")
  - COI request due within 2 business days → Today
  - stale quote crossing the follow-up policy with no draft → Today
  - customer promise due today ("I'll call you Thursday") → Today
- Stays consistent with `[[no-proactive-notifications]]`: this is a pull surface. Texts remain reserved for exceptions (the existing P1 system alerts, the recon noon fallback).

### 4.3 Identity (the hard engineering part)

Today's findings are regenerated nightly with no stable identity, which is why dismissals are fuzzy JSON matches. Each detector must emit a **stable key** (`detector + entity ids`, e.g. `D5:estimate:1576`) and an **evidence fingerprint** (hash of the facts that matter, e.g. last-inbound-message id + balance). State attaches to the key; the fingerprint decides "material change." Getting this right is most of the migration work.

---

## 5. Area by area: what each holds, and what exists already

| Area | Holds | Already built (reuse) | New |
|---|---|---|---|
| **Sales** | lead flow, assessment→quote gaps (D9), quote drafts + edit labels, stale quotes + follow-up queue, approved-not-scheduled (D4), close rate, \$ quoted, partners | triage D4/D5/D9/L1, quote drafter harvest, stale-quotes runner, message drafts | funnel view, partner/Ed channel row |
| **Jobs** | this/next week calendar, stubs/holds (D10/D13/D14), incomplete events (D11), field completions, done-not-invoiced (D1), Mike's capacity, callbacks | triage detectors, scheduling directives view in CC | utilization, booked-weeks-out trend |
| **Money** | cash by Relay sub-account (via QBO), AR aging, undeposited funds, weekly recon card, monthly P&L, gross margin, owner take-home, Ed commissions, tech #2 vault | recon plan, `getUndepositedPayments`, commissions pipeline, D2/D3 | P&L/margin/take-home from reconciled books, vault tracker |
| **Marketing** | spend by channel (QBO categorized), leads + customers by source (PD attribution), **CAC by channel, trailing 3-month trend**, reviews, website/ads health; Ed as a channel row (his cost vs his channel's revenue → the spring decision) | PD attribution pipeline, Google Ads tooling in `../aac-astro/scripts`, Lighthouse history | the CAC model (depends on recon categorization being right), reviews feed |
| **Admin** | obligations calendar, insurance policies + COIs, documents vault, entity/rebrand checklist | nothing systematic (memory notes, doc 18 ledger) | everything; see §6 |
| **Commercial** | bid opportunities, pursuit pipeline, prequal packet | quoting ruleset (for draft bid prices) | everything; see §7 |
| **System** | heartbeats, crons, worker health, OAuth token/scope status, Gemini canary | middleware observability work, health page | fold existing into one compact page |

**Marketing production** (the 4.1 social post pipeline) is a separate question from marketing *measurement*. Recommendation: measurement lives here from the start; production folds in as a Marketing sub-page when 4.1 is built, rather than a second owner app with its own login. (See decisions.)

---

## 6. Admin: the bureaucracy engine

The research inventory (`research-compliance.md`) found ~40 recurring obligations for an entity like AAC: MA (and maybe CT) annual reports, HIC renewal, Matt's CSL (birthday + CE hours), 941/940/W-2/1099 (payroll provider files, we verify), 1065/K-1 + MA Form 3 if multi-member, DUA + PFML quarterly, M-941 (even zero-wage), GL + WC renewals **and audits**, vehicle registration/inspection, possibly USDOT (if truck ≥ 10,001 lb GVWR), OSHA silica written exposure control plan, software/domain renewals, and (for commercial) prevailing wage certified payroll, bonds, DCAMM, COMMBUYS/SAM registrations.

### Model (from the research, trimmed)

- **Obligation definitions** generate **instances** (definition = "MA annual report, anniversary of formation"; instance = "2026 report, due Nov 19, status filed, confirmation #, receipt PDF").
- Due dates are **computed** from anchors (formation date, Matt's birthday, policy expiry), never typed.
- Each obligation has an owner (Matt / payroll provider / CPA / broker). "Handled by someone else" obligations become **verify-filed** items, not do items.
- **No instance closes without evidence** (receipt, confirmation number, document).
- **Documents** carry expiry dates; expiries spawn renewal instances automatically (COIs, licenses, policies).
- Lead times: show at T-30 on Admin and "Coming up"; promote to Today at T-7; overdue is red, and dismissing it asks for a confirm.
- Dependencies: HIC renewal needs a current WC affidavit; prequal packet needs a good-standing certificate, etc.

### COIs: the time sink Matt named

Flow: request arrives (email/text) → AI extracts holder name/address, additional-insured type (ongoing CG 20 10 / completed CG 20 37), primary & non-contributory, waiver of subrogation, limits, job address, deadline → **gap check against the policy's actual endorsements** (does Kinsale's blanket AI cover this, or does it need a specific endorsement?) → drafts the request email to Titan (Mike Mullaney / Karie Michaud) as a Gmail draft → issued COI filed against holder + job → after each October renewal, auto-queue reissue to every active holder. First question for Titan: **do they have a self-service COI portal?** (HawkSoft, Vertafore, NowCerts, Applied CSR24 all offer one; if Titan has it, the draft step becomes "issue it yourself in 2 minutes").

### Entity transition

The Luc separation and rebrand (`docs/aac-future/`, doc 18 notification ledger) will likely mean a new entity, new registrations, new EIN, re-issued COIs, re-registered vendor accounts. The obligations registry must be **per entity** from day one so the transition is "seed the new entity's obligations, wind down the old one's" and the doc 18 checklist imports as items, not a separate spreadsheet.

---

## 7. Commercial: a separate bet with its own gates

Commercial work is a **demand lever** (demand is the binding constraint), so it's aligned with the charter, but it brings bonding, prevailing wage, certified payroll, and prequalification. It gets its own crawl/walk/run, gated by real prerequisites rather than by the dashboard schedule.

**What the research says is realistic for a 3-person crack-repair shop** (details + sources in `research-commercial-bids.md`):
- Sweet spot: **public jobs under \$50k** (c.30 §39M / c.149 written-quote tier: 3 quotes, lowest responsible wins, no bid deposit below \$50k), housing authority small projects, school summer repairs, municipal **on-call contracts** (Quincy had an on-call waterproofing contract bid 5/2025; expect a re-bid ~2027-28), and GC subcontracts on private commercial jobs.
- **OSD statewide Trades contracts** (TRD02 masonry/concrete expires 8/31/2027; TRD01 general expires 3/31/2027): getting on one lets towns hire you without public advertising. Probably the single best public-sector move; ask the category manager about re-bid timing.
- Gates: prevailing wage applies to **every** public construction job with no dollar floor (weekly certified payroll; reprices Mike's labor on those jobs); payment bond on public contracts > \$25k; bonding needs CPA-reviewed financials (blocked on the 2026 books); DCAMM certification only matters > \$150k.
- **ToS matters for the AI agent:** ConstructConnect explicitly bans AI agents/browser automation outside its paid API; Autodesk/BuildingConnected has an official API; PlanHub bars copying content. The safe automation inputs are the **government sources** (COMMBUYS public view + alert emails, the MA Central Register weekly PDF, SAM.gov API) and **invitation emails** from GC platforms. The agent reads email + public notices; humans click "intend to bid" inside private platforms.
- Economics: plan on 5-10 bids per win; prioritize repeatable on-call/term contracts over one-offs.

**Crawl (cheap, can start any time; ~1 day of Matt's time):** register on COMMBUYS (UNSPSC codes for concrete repair/waterproofing/masonry), subscribe to the Central Register (~\$101/yr), free profiles on BuildingConnected / PlanHub / ConstructConnect Bid Center / Procore, register on ~20 South Shore town/housing-authority portals, route every alert to one inbox label. Email OSD about TRD01/TRD02 re-bids.
**Walk (the weekly agent):** parse alert emails + the Central Register PDF → classify trade fit, distance, chapter/tier, bond/prevailing-wage/DCAMM gates, dates → ranked weekly list on the Commercial page (items, same verbs). Pursuit pipeline stages. Draft RFIs, draft bid price from the quoting ruleset, document checklist, follow-up reminders on bid results.
**Run:** statewide contract slot, SBA-backed bonding line, prequal packet auto-assembled from the Admin vault (W-9, good standing, COIs, licenses, safety program, silica plan, OSHA 300 logs), win/loss learning.

**Honest risk:** capacity. One tech, no big resurfacing until tech #2 (`[[mike-no-large-resurfacing]]`). Commercial walk should line up with the March 2027 tech #2 hire, and the scorecard's capacity numbers should gate how many bids to chase.

---

## 8. Architecture

| Concern | Decision (proposed) | Why |
|---|---|---|
| Host | `apps/command-center` (Next.js 15, existing scaffold) deployed to Vercel with a custom domain | Already has layout/auth/ui/Redis; phone access; no SSO-on-webhook trap since it's a UI |
| Auth | **Fix first.** Migrate to field's Redis-backed sessions (audit P0-5 + P5-9), share the auth lib with marketing | Financial + compliance data can't sit behind "any cookie works" |
| Detectors | Move `tools/src/triage` detectors into a package (`@aac/insights`), run in the **cloud worker** on cron; laptop launchd retires after parity | Same path the quote drafter and message drafts already took (`docs/plans/launchd-to-server-workers.md`) |
| Item state | Redis via `@aac/shared-utils` key builders: item by stable key, Today rank list, mute rules | Small, hot, fits Redis |
| History + registry | **Decision needed**: scorecard history (13 weeks × 12 rows, months of trends), obligations/documents/policies/COI requests, bid pipeline are relational and historical. Options: keep everything in Redis (awkward queries) or add Turso/SQLite+Drizzle (already chosen for marketing) | See decisions |
| Documents | Vercel Blob (already chosen for marketing images) | COIs, policies, receipts, licenses |
| Metrics layer | One shared module computes every number once (definitions + date basis); Overview, area pages, scoreboard md, and Ed/CAC all read it | DRY; the ⓘ definitions come from the same source |
| Writes to external systems | Only explicit owner actions (approve recon categorization, send-to-Titan draft, close an estimate) through `@aac/api-clients` | Keeps the "read-only by default" rule from the old spec |
| Middleware | Untouched | Sacrosanct |

The command-center CLAUDE.md rule "no data of its own" changes: the app now owns item state, the obligations registry, and documents. That's a deliberate decision to record in DECISIONS.md.

---

## 9. Crawl / walk / run

Each phase ships something Matt uses daily before the next starts. No phase starts without the previous one being *used*, not just deployed.

### Phase 0: Design before code (this week)
- Matt answers the open decisions below.
- **Clickable low-fi wireframes** (an HTML prototype with fake data): Overview Today/Week/Month, one area page, the Customer page, the item verbs (drag, done, snooze, dismiss-with-reason, → Today). Matt clicks through on desktop and phone and reacts. Iterate until the shape is right. Cheap to change now, expensive later.

### Phase 1, Crawl: Today replaces triage.html (Nov-Dec)
1. Auth fix + deploy (custom domain, phone-ready).
2. Item system: stable keys, fingerprints, states, verbs, ranks, mute rules, two lanes.
3. Detectors move to the cloud worker; findings become Items. Overview **Today** at parity with triage.html, plus the verbs. Retire `com.aac.triage` after a week of side-by-side.
4. Customer page v1 (timeline from data triage already collects). *Built 11/03:* `/customers` search + `/customers/[id]` timeline (QBO quotes/invoices/payments, Quo texts/calls, Gmail, calendar visits matched by address, phone or name) on `@aac/customers`, which now also owns the name/address matching triage uses. Today items link to it by customer name. Not yet: Pipedrive attribution, field-app photos, the lifecycle ledger.
5. **Admin v1:** obligation registry seeded (needs Matt's facts, see decisions), "Coming up" strip, T-7 promotion, documents vault for policies/COIs/licenses.
6. The weekly recon + deposit reminder build (already planned) lands its Monday card and deposit items here instead of in triage.html.

### Phase 2, Walk: the numbers (Dec-Feb)
1. Metrics layer + **This week** scorecard (13-week history starts accruing; backfill from reconciled books where possible).
2. **This month** + charter tracker; auto-generated `03-scoreboard/` files; backfill Jun-Oct 2026.
3. **Money** page: cash, AR, undeposited, P&L, margin, take-home, vault.
4. **Marketing** page: spend by channel + CAC trend + Ed channel row. Depends on recon categorization; add Google Ads spend detail.
5. **Sales** + **Jobs** pages (mostly re-homing existing detectors and lists).
6. COI request workflow (email detection → extraction → gap check → Titan draft).
7. Commercial **crawl** (registrations + alert inbox) runs in parallel; it's Matt's time, not build time.

### Phase 3, Run: intelligence and new fronts (spring 2027)
1. Commercial page + weekly bid agent (walk), then pursuit automation.
2. Dismiss-reason learning tunes detectors; escalation rules tuned from real use.
3. Marketing production (4.1 social pipeline) folds in as a Marketing sub-page.
4. Ed keep/cut decision (spring 2027, per Matt 11/02) made from the Marketing page's channel row and his five KPI rows.
5. Prequal packet auto-assembly; entity transition re-seeding when it happens.

---

## 10. What we're deliberately not doing

- A configurable card grid / drag-anywhere layout (the old spec's "card configuration"). Fixed, opinionated layouts; customization is ordering *items*, not *widgets*.
- Gauges, pies, 3D, color-only status (Few, NN/g).
- AI that reorders Matt's list, or changes anything external without approval.
- Daily digest texts or emails (`[[no-proactive-notifications]]`).
- Scraping platforms whose terms forbid it.
- Rebuilding things QBO/Gusto/the broker already do; we track that they happened.

---

## 11. Open decisions for Matt

See also **`round-2-funnel-queues-system.md`** (2026-11-02): queues (expand into all of one type), the funnel and "where's the problem" readout, the seasonal weekly/monthly scorecard, and deep System health. It proposes a lifecycle ledger as a Phase 1 foundation and has its own open questions (§8).

See also **`plans-inventory.md`** (2026-11-02): every plan in the repo marked as live, planned, superseded or dead, with what each one needs the command center to surface. It lists the gaps (manual categorization items, the deposit loop, Edward's decision date, unchecked automations), the ideas worth reviving, and 11 open questions (§5).

1. **Areas:** Sales / Jobs / Money / Marketing / Admin / Commercial / System, plus Customer pages. Right cut? Renames? Is "People" (Mike, Ed, tech #2 hiring, expectations docs) its own area or does it live in Jobs/Money?
2. **Critical Number** for This month: rolling 3-month revenue vs \$50k/\$80k (what the charter literally measures), or owner take-home (the charter's objective function)? Recommendation: revenue as the headline because it's the kill criterion, take-home right beside it.
3. **Scorecard:** pick 8-12 from the draft list in §3.2 (or add).
4. **Owner hours:** the charter's second constraint has no data source. Accept a rough automatic estimate (calendar + Quo activity + dev sessions), a 10-second weekly self-report on the Week tab, or drop it?
5. **Storage:** add a small relational store (Turso, already chosen for marketing) for history/registry/bids, or stay all-Redis? Recommendation: Turso.
6. **Marketing production:** fold the marketing app's UI into the command center later (one owner app, one login), or keep two apps? Recommendation: fold in.
7. **Compliance facts** to seed Admin (each one changes which obligations apply): formation state (CT vs MA) + foreign registration; tax classification (1065 multi-member vs other); DBA certificate on file and where; truck/trailer GVWR (USDOT); HIC number + expiry; Matt's CSL expiry + CE status; payroll provider (who files 941/DUA/PFML); Kinsale endorsements (blanket AI / waiver?); WC carrier + EMR; does Titan have a COI portal.
8. **Commercial crawl timing:** do the free registrations now (cheap, starts the learning), or hold until Phase 2?

---

## 12. Brought forward from the plans inventory (2026-11-02)

Matt asked that the gaps and the good ideas from months of older plans become part of this plan, not a side list. Detail and sources for each line are in `plans-inventory.md` §3 and §4. Matt's answers on 11/02: Edward's decision is **spring 2027**; the stale-quote follow-up goes live **next**; manual categorization **is** its own item type; **no** books-trust warning on dollar figures.

### 12.1 New item types and queues, by area

**Money**
- **Needs your categorization** (new item class): one item per judgment transaction (Venmo, ATM cash, possible draws, unknown payees, check deposits that must be matched, not posted), each with a best guess. Verbs: pick a category, and **Make this a rule** (writes the QBO rule or `category-map.ts` entry so it never asks again). The obvious categorizations stay a single confirm-lane batch. Metric: judgment items per week, which should trend down.
- **The whole deposit loop**, not just the Monday card: Thursday "N deposits still uncleared, confirm the suggested matches before Friday" (problem weeks only); Friday per-tech summary of what each reminder said (confirm lane, no text to Matt); items held back from a tech's reminder; payments with no field-app record route to Matt, never a tech; "marked deposited but never landed in Relay" as its own, worse class than "undeposited."
- **Paid is not banked:** a "paid, awaiting deposit" state that Ed's commission and every revenue figure respect; Undeposited Funds shown next to revenue.
- **2026 books repair as tracked items** (the remaining Beacon and Relay judgment items, the duplicate queue, the account merge, Phillip James) until it's done.
- **Lost-mail receivables:** tag AR that was mailed to Quincy and never arrived; remit-to fix tracked.
- **Invoice-create skip reasons** (no PD match, no QB customer, several accepted estimates, no email) become items at the source instead of log lines.
- Dated **tech #2 vault deadlines** (Dec 31 checkpoint, Jan 31 go/no-go) and the year-end renewal cash cluster on This month.

**Sales**
- **Stale-quote follow-up** queue: drafts to send, awaiting-human (red at 14 days), needs-a-call, flip-to-accepted, recommend-close. Its "last live run" is a System check.
- **Capacity-hold queue:** large quotes parked until tech #2 (about \$60k+). It doubles as the demand evidence for the hire.
- **Scope changes on open quotes** (T4 flags): human-owned become items, bot-owned regenerate in the confirm lane. The open-quote index is the canonical "quotes awaiting decision" population.
- **Old-price acceptance check:** a customer accepts a quote priced under an older policy → item.
- **Loss reason** captured on every lost quote (fit miss vs sales loss), feeding the funnel.
- **Dropped-lead counter:** real leads never answered, as a weekly red row, not just a reply-time percentile.

**Jobs**
- **Tech accountability:** % of jobs logged same day, owed photos. Becomes the onboarding scorecard for tech #2.
- Card-paid-but-QB-unpaid mismatches and ambiguous job-to-invoice matches as items.
- Scheduling: manual overrides of suggested slots, two-job-day lateness.

**Marketing**
- **Reviews:** ingest Google reviews, suggest replies, 1-2 star reviews go to Today, velocity against a 7-10/month target, skip the review-prompt text when the customer already reviewed.
- **Ads drift check** (bidding strategy, auto-apply off, never more than 30 days unreviewed) and **Stream A lead disposition**, which CAC by channel depends on.
- **Website-to-call matching** (GA4 click to Quo call, validated at 57% with no false matches) fills lead source, which the funnel study found is almost entirely blank.
- **Ed channel row** for the spring decision, with his five KPI floors (partners, meetings, attributed leads, pipeline, closed-won) on the monthly scorecard.
- **Data-retention archiving:** GSC and GBP history expire at 16-18 months; a scheduled export protects the seasonality baselines.

**Admin**
- **Important Dates and renewals** (in every spec since March, never built) is the obligation registry's first screen.
- **Event-anchored obligations:** deadlines computed from "signing," "cutover," and "name picked" (8822-B, WCRIBMA, final 1065, bank signer cards, name exit, domain handover, 301s, non-competes), not fixed dates.
- Before signing: weekly GBP suggested-edit and access-request check; asset-control checklist (registrar, Quo owner, Workspace, Ads/GA4/GSC owners, bank signers).
- GL prior-work date fix and the Sept 2028 claim-reporting sunset; ZoomInfo non-renewal watch.
- Recurring owner reviews (quarterly budget, monthly cost check) and a **standing rules list** next to mute rules.

**System** (adds to round-2 §5)
- The **outside-in watchdog** is the named build (still unbuilt), with its four-injected-failure acceptance test.
- Heartbeats for `quote-email-tick` and `sweep`; stale-quote "last live run"; quote-drafter assets present and fresh.
- Webhook registration integrity for Quo, Pipedrive and Google Ads, plus a per-API smoke check.
- Internal-number skip list correctness (Ed's cell, tech cells, agent line never in customer pipelines).
- Relay Income balance can cover Intuit pulls (bounces risk QB Payments suspension).
- Dead feeds and balance ties from the recon plan (R1, R2, R6, R7) as dependency checks.
- **Per-automation acceptance rate:** how often Matt accepts each automation's output unedited. This is the evidence for every future auto-send decision.

### 12.2 Where they land in the phases

- **Now (before Phase 1):** stale-quote follow-up live; unload the laptop drafts backup once its replacement is confirmed (the worker already does this job, and the laptop copy competes with it for Quo's rate limit).
- **Phase 1 (Today):** categorization items with Make-a-rule, the deposit loop items, invoice-create skip reasons, dropped-lead row, stale-quote and capacity-hold queues, Important Dates, watchdog and the System checks above.
- **Phase 2 (numbers):** paid-not-banked state, tech accountability, reviews, website-to-call matching, Ed KPI rows, acceptance rate per automation, data-retention archiving.
- **Phase 3 (spring):** Ed decision from the Marketing page; event-anchored obligations re-seeded at signing and cutover.

## 13. Round 3 (2026-11-03)

Matt asked for: his own to-dos (quick add, anchored to jobs, lead times worked backward, first-time-job prep checklists), cards he can add to the dashboard (one-off or permanent), a commissions and Ed-decision view, and a new **agreement** item class for things that run in the background (first case: Mike's truck repayment, which was set up as a pay cut with no signed agreement). Also a pinned review of what the funnel drop-offs really are. Detail, data sources and phasing: **`round-3-todos-cards-ed.md`**.

## 14. Data-reality decisions (Matt, 2026-11-03)

Checked the mockup against the data we can actually pull. Decisions:

- **Cash by Relay account: real, from QBO.** Both banks feed QBO again (reconnected 10/29), and five Relay accounts already tie. Each account tile shows its QBO balance plus a "posted through" date (the latest posted transaction in that register), so a stale bank-feed queue is visible. The 2026 books cleanup that's left is tracked in `analysis/02-strategy/books-2026-remaining.md` and shows as items on Money until it's done.
- **Lead sources, CAC by channel, the source flow chart: built but switched off**, with a large notice on the card: lead source isn't captured at intake (blank on 1,209 of 1,601 2026 contacts), so this has to be solved first. Retrofitting old leads is unlikely. Starting source capture is its own build item (website-to-call matching, Ads lead disposition).
- **Owner hours: estimated from activity, AAC work only.** Count 15-minute blocks with any of: Claude Code messages in AAC codebases only (each session is stored under its codebase's folder in `~/.claude/projects/`, so `aac`, its worktrees, and `aac-astro` count, and `ernie-messages`, `judgementgame` and other personal projects don't), Quo texts and calls Matt made, Gmail sends from the business account. Then add a fixed percentage for unlogged work. Claude.ai web and desktop chats aren't in these logs, which the percentage has to cover. It's a trend line (up, down, flat), labeled as an estimate. 10/13-11/03 spot check: 69 h in AAC codebases vs 10 h in personal ones.
- **Documents vault: yes, with a facts sheet.** Beyond the files (policies, COIs, licenses, receipts), a "facts we get asked for" panel with one-tap copy: EIN, HIC number, CSL number, MA and CT entity IDs, insurance policy numbers, W-9, and so on.
- **Commercial: placeholder page** linking `research-commercial-bids.md` and README §7. Built later.
- **Mike booked %: from the calendar.** Event length, on events where Mike's email is an attendee (the same filter as suggestSlot's `selectBusyEvents`), divided by available hours.
- **Ed commissions: Datapay payroll PDFs go into a database.** Pull them from Gmail on each payroll run (`tools/src/scratch/datapay-reports.ts` is the prototype), parse per-employee lines (regular pay, commission, deductions), store as rows. This also feeds payroll cost and the Mike repayment agreement check.
- **"Quote opened": not available.** Checked the API 11/03. Estimates expose only EmailStatus and DeliveryTime (when it was sent). Invoices expose `EInvoiceStatus` (Sent / Viewed / Paid), but no view count. So build "invoice viewed", not "quote opened N times".
- **Google reviews: direct API (approved), email parsing as the stopgap.** Google approved AAC's project for the Business Profile API on 3/17/2026 (email to matt@attackacrack.com, case 3-5697000040870), but it was never wired: posting has run through Buffer since 3/5/2026 (`aac-astro/scripts/buffer-post-projects.js`), `batch-post-gbp.js` still has placeholder IDs, and no saved token has `business.manage`. To turn it on: enable the Business Profile APIs in the approved Cloud project, re-auth with `business.manage` (`tools/src/scratch/reauth-google.ts`), add a GBP client to `@aac/api-clients`. Until then the reviews feed parses Google's "X left a review for Attack A Crack" emails (50+ in the last year).
