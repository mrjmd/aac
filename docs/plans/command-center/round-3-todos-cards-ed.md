# Round 3: your own to-dos, cards, the Ed view, and agreements

Matt, 2026-11-03. Four asks: (1) add things to the list myself and prioritize them, (2) add a card to the dashboard, one-off or permanent, (3) a full commissions and Ed-decision view, (4) track the Mike truck repayment properly. Plus one pinned research task. This extends README §4 (the item system) and §12.

---

## 1. Your own to-dos

**What exists:** a manual to-do model already lives in Redis (`todo:{id}` + `todo:list`, keys in shared-utils), with an API and a page in `apps/command-center` (`/todos`). Triage already collects it each morning. But the command center was never deployed (and its auth is broken), and triage never shows the list. So the capability exists and nothing you look at shows it.

**In the v2 design** a manual to-do is just an Item with `source: manual`, so it gets the same verbs as everything else (Done, Snooze, → Today, Reorder) and sits in your order on Today. What it needs beyond today's model:

- **Quick add from anywhere.** One text box (and Cmd-K) on every page: "Order carbon fiber straps for Lisa Martin by Nov 14." Parse the date; you confirm. Later, the same capture by texting the agent line.
- **Anchors.** Attach a to-do to a job (calendar event), customer, quote or person. The item then shows on that customer's page and on the job card, and moves if the job moves.
- **Lead times, worked backward.** "Due 3 weeks before the Lisa Martin job" is stored as an offset from the job date, not a typed date. If the job moves, the deadline moves.
- **Checklists.** A to-do can have steps, each with its own offset ("order T-21, confirm delivery T-5, walk Mike through it T-2").
- **First-time-job prep template.** When a job is the first of its kind (new technique, new equipment, new material), one click spawns the prep checklist: materials ordered, delivery confirmed, equipment tested, instructional videos found and sent to the tech, technique walkthrough with the tech, contingency plan if it goes badly. Same template for any new service line.
- **Priority is yours.** Manual items enter "New since you looked" and you place them. Nothing reorders them.

**Current examples to seed it with:**

| To-do | Anchor | Steps |
|---|---|---|
| Shivani Sandesh Lad: high-pressure polyurethane job, 7 cracks + 2 pipe penetrations | Calendar 11/11-11/12 | Confirm pump, ports and resin deliveries arrived; test the pump before the job; find the best instructional videos for the pump and port technique and send to Mike; walk Mike through it; plan B if the pump fails |
| Lisa Martin: carbon fiber straps, first one ever | Calendar 12/1 | Pick the system and order materials (lead time unknown, so early); confirm measurements from the 9/30 assessment (34' and 23' walls, bow depth); install instructions and videos to Mike; confirm delivery |
| Mike truck repayment backfill | Mike (person) | See §4 |

**Stopgap until Phase 1:** a small CLI (`tools/src/todos`) to add/complete items in the existing Redis store, and a "Your list" section on triage.html that renders them. That's a few hours of work and gives you capture and visibility now; the v2 Today page reads the same store later, so nothing is thrown away.

---

## 2. Cards: adding things to the dashboard

Two kinds, with one mechanism:

- **Built-in cards** are what the area pages already plan (Numbers tiles, queues). They're code.
- **Your cards** are things you ask for: "commissions," "Mike repayment," "Shivani job readiness." Each is a **card definition** stored as data: a title, which area or page it lives on, a data source (one of a fixed set of named queries, e.g. `commissions.summary`, `agreement.balance`, `items.anchoredTo(job)`), a display type (number tile, short list, progress bar, checklist), and optionally an expiry ("show until 11/13").

How you add one: ask me in a session ("add a card for X"), I write the query if it's new and the definition. Later, an "Add card" button that picks from the existing queries. A one-off card is just a definition with an expiry; a permanent one has none. Area pages render built-in cards first, then yours, in the order you drag them.

Why this shape: the cards stay cheap to add (a definition, not a page), the data logic stays in one place (named queries, tested), and nothing breaks when a one-off card expires.

---

## 3. Commissions and the Ed decision view

A sub-page under Marketing ("Ed"), plus a small card on Money.

### 3.1 Commissions

| Question | Answer from | Status |
|---|---|---|
| Paid YTD | Datapay payroll reports (commission line per run, e.g. \$1,285 YTD through #57) reconciled to `analysis/data/commissions/ledger.json` | Ledger is behind payroll (has 1 entry); payroll PDFs now pulled to `analysis/data/payroll/` |
| Owed now (customer paid, not yet paid to Ed) | commissions `findings.events` where not paid to Ed. Must respect paid-not-banked (README §12) | Built, manual run |
| Looming (invoiced, customer hasn't paid) | `findings.pendingInvoices` | Built |
| Waiting on booking (accepted, not scheduled) | open estimates Accepted + no calendar event (same join as triage D4) | New join |
| Quotes out (pending) | `findings.openEstimates` Pending | Built |

The commission run becomes a pay-cycle item: "N commissions owed, \$X, add to this payroll" with the Datapay email drafted.

### 3.2 Ed's jobs over time

- Ed-attributed customers (PD closure: referred by Ed, chain, owned by Ed) joined to calendar jobs: past and upcoming, filterable.
- Monthly trend: Ed leads, assessments, quotes, wins, revenue, against the rest of the business.
- Each row links to the customer page so you can see the full history.

### 3.3 The decision readout (spring 2027)

| Metric | Source |
|---|---|
| Channel revenue and gross margin (paid) | QBO invoices + payments for Ed-attributed customers |
| Ed's fully loaded cost | Datapay: base + commissions + employer taxes; plus phone, mileage, any expenses (QBO) |
| Net contribution, trailing 3 and 12 months | the two above |
| Five KPI floors: new partners, meetings logged, attributed leads, attributed pipeline, closed-won | PD (partners = realtor persons Ed owns or referred, meetings = PD activities, leads/pipeline/won = attribution closure + QBO) |
| Close rate and time-to-pay vs other channels | funnel ledger split by channel |
| Referrer network: how many partners have ever sent a lead, and repeat senders | PD referred-by chain |

**Data gaps to close first:** PD attribution leaks (audit P3-2: inbound leads without PD records), meetings only count if Ed logs them in PD, and Ed's line is filtered out of Quo, so his call activity isn't visible. The readout should show where it's guessing.

---

## 4. Agreements: things that run in the background

The Mike repayment is a new Item class: an **agreement**. Something agreed once that then runs on a schedule, where the risk is that it drifts silently. Fields: parties, start, total, terms (amount per cycle), schedule source (where to verify each installment happened, here the Datapay payroll report), end condition, documents (signed or missing), and backfill to-dos.

The card shows: balance remaining, installments verified vs expected, projected end date, missing documents in red. Items fire when an installment is missing from payroll, when the end date approaches (tell Datapay to stop), or when a document is still unsigned after N days.

Other agreements that fit the same class: Lorraine Sheehan's \$675 balance, the Brendan O'Connor check, Ed's commission terms, any customer payment plan, the Luc arrangement once signed.

Current record and backfill list: `analysis/02-strategy/mike-vehicle-repayment-2026.md`. The short version: Datapay made it a \$250 pay cut instead of a loan deduction (so nothing records the repayment and the W-2 changes), no signed agreement exists, the accountant hasn't seen it, the \$12,185.07 is booked as a travel expense, and Mike's \$3,000 Venmo (7/22) landed in Relay Income as if it were revenue.

---

## 5. Pinned research: what the funnel drop-offs really are

The funnel baseline (`analysis/02-strategy/funnel-baseline-2026-11.md`) counts every unconverted assessment and photo lead as a drop-off. Matt's read: a real share are jobs AAC chose not to take (wrong fit, too big, not worth it) and then never closed out with the customer. That is a different problem (follow-up hygiene) from losing a job we wanted (sales).

Task: hand-review a sample (around 40, split between assessments and photo leads, across seasons) and label each: we declined and closed it out, we declined and never told them, customer went quiet, customer chose someone else, still open. Output: the real "lost a job we wanted" rate, and the "never closed out" rate as its own number. This also defines the **loss reason** field (README §12 Sales) and a "decline and close out" message template.

---

## 6. Where these land

- **Now:** the to-do stopgap (CLI + triage section); the Mike backfill items; Shivani prep this week.
- **Phase 1:** manual items with anchors, offsets and checklists on Today; quick add; the first-time-job template; agreement items.
- **Phase 2:** card definitions and named queries; the Ed sub-page and commissions card; the funnel drop-off review.
- **Phase 3:** the Ed decision readout.
