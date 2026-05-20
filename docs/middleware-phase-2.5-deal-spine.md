# Middleware — Phase 2.5: Deal Spine + Conversational Agent

**Status:** DRAFT — initial pass, expected to iterate heavily with Matt
**Created:** 2026-05-19
**Owner:** Matt
**Supersedes / refines:** `docs/MASTER-PLAN.md` Phase 2.5 (E/F/G/H)

> This spec is a **planning document, not a build spec yet.** It captures the
> reframe that emerged from the 2026-05-19 conversation about the limits of
> the current calendar-as-source-of-truth model. Every section is open for
> pushback before any code is written. Decisions get logged at the bottom as
> they're made.

---

## 1. Vision (Run state)

The agent is the operational nervous system of the business, accessed by Matt
through a single text-message interface (the agent comms line). Three threads
of capability define the Run state, and they reinforce each other.

### 1.1. Real-time intent classification across every signal

Every inbound signal — a customer text, a call transcript, a QB status
change, a calendar edit — is read by the agent the moment it arrives, in the
context of that customer's full history. The agent classifies what's actually
happening:

- A new lead asking for a quote
- A quote approval ("looks good, let's do it")
- A scheduling negotiation ("Tuesday won't work, how about Thursday?")
- An on-site assessment request ("can someone come look at this?")
- A callback for a finished job ("it's still leaking")
- A pricing question / objection
- A "you forgot something" complaint
- A confused follow-up that doesn't fit a known category

These are not the same thing and they don't deserve the same treatment. The
classification drives the action: open a deal at the right stage, propose a
time slot, draft a response for Matt to approve, escalate ambiguity, or
silently log a non-action. The agent doesn't wait for a daily cron to notice
what happened — it reacts as the signal arrives.

### 1.2. The agent text interface IS the business operating layer

The agent comms line is not an alerting channel. It's how Matt runs the
business day-to-day. It serves three overlapping classes of interaction:

**Write actions** — instructing the agent to do something:
- *"Schedule a callback for Jones sometime next week."* → agent proposes slots
- *"Cancel tomorrow's 8:30 with Davis, he just called to reschedule."* →
  agent updates calendar, texts Davis, logs in PD
- *"Stop sending review-prompt SMS to commercial customers going forward."*
  → agent captures as a standing rule and applies it from now on

**Read queries** — asking the agent about business state. The agent has
read-access to every system that holds business data (Pipedrive, QuickBooks,
Google Calendar, Quo conversation history) and can answer arbitrary
questions across them:
- *"That client in Rockland we went to last week — what's their phone
  number?"* → agent searches calendar by date+location, finds the deal,
  returns the contact
- *"Any jobs today that don't have invoices attached yet?"* → agent crosses
  today's calendar events against open deals to find gaps
- *"What's our deal flow look like? How many jobs scheduled in June?"* →
  agent aggregates across deals and calendar
- *"Did Smith ever reply to the quote I sent last Tuesday?"* → agent reads
  the conversation history and tells him
- *"How much did we invoice in April vs May?"* → agent pulls from QB

**Conversational meta** — interrogating the agent itself:
- *"What's the status of the Smith job?"* → agent summarizes the deal,
  recent comms, what's pending
- *"Why did you skip Lori yesterday?"* → agent explains its reasoning and
  asks if it should retry differently next time

Matt's corrections, confirmations, overrides, standing rules, and queries
from this dialogue all become training signal. The autonomy ladder (§6) is
the formal mechanism for promoting trust on write actions; the day-to-day
texting is the substrate that drives those promotions and builds the
agent's understanding of how Matt thinks about the business.

### 1.3. Together: an adaptive learning business OS via text

Scheduling automation, auto-invoicing, deal lifecycle management, project
staging for marketing, attribution accounting — these are *applications*
running on top of the agent platform, not separate cron-and-rule subsystems.
New capabilities get added by teaching the agent (via text and via code)
rather than by bolting on more deterministic automations.

The text interface is the durable productized surface that Matt collaborates
with the business through. Everything else in this spec — deal model,
calendar link, autonomy ladder, phased rollout — is in service of getting
that interface load-bearing.

### 1.4. Middleware errors as first-class agent signals (self-diagnostic ops)

The intent-classify → propose model that handles customer signals also handles
**middleware health signals**. Every failure mode the middleware can detect —
a Quo sync that didn't complete, a webhook that returned non-200, a QB token
refresh that failed, a cron that produced zero matches when it should have
produced N, a contact created in Pipedrive with no Quo back-link after the
expected window — is an input the diagnostic agent processes. Matt doesn't
hunt for errors in `/api/health`; the agent finds them, diagnoses them, and
texts a complete writeup.

When the middleware logs a failure (current pattern: `logHealthError(...)`
plus thrown exceptions), the failure record is routed to the diagnostic
agent, which:

1. **Reads** the failure context — the logged error, the affected entities,
   recent state across Pipedrive / Quo / QB / Redis, recent webhook history.
2. **Diagnoses** root cause by tracing through the systems with the same
   read-access tool surface used everywhere else (§7.2 walk #2).
3. **Proposes a fix** — either an immediate ops action ("run this idempotent
   sync to repair Nick Puccio's record") or a code-level change ("the search
   method full-scans Quo contacts and times out at 30s; here's the patch to
   use the externalId index").
4. **Texts Matt from the agent line** with a structured writeup, modeled on
   the exact framing Matt called out:

   > *"We noticed your Quo contacts aren't getting updated after Pipedrive
   > enrichment. We looked into it: `searchContactByPhone` is doing a
   > full-table scan of every Quo contact and timing out at Vercel's 30s
   > limit before reaching `createContact`. Two affected contacts in the last
   > 48h (Nick Puccio, Jane Doe). Want to know more, or should I (a) run
   > the one-shot script to repair the two affected records and (b) deploy
   > the externalId fix?"*

   Matt's reply continues the conversation: ask follow-ups, request
   alternatives, accept ("go"), or override ("just (a) for now, hold (b)").

The blast radius rule from §6 still applies. An ops fix that re-runs an
idempotent sync can sit at level 2 (act-and-notify) once trusted; a code
change is always level 1 (propose + explicit go) because it's a deploy.

**This subsumes the existing health endpoint as the primary error surface.**
`/api/health` continues to exist as a passive diagnostic Matt can inspect
manually, but it stops being the *entry point* for noticing problems. The
entry point becomes the agent's continuous read of every middleware
operation's outcome.

**Apparent tension with §2.7 (no proactive notifications):** there isn't one.
The existing rule reserves the agent comms line for "asks and exceptions,
not heartbeats or status pings." Middleware failures *are* exceptions.
Routine successful operations stay silent; only deviations from expected
behavior surface. This is consistent with how customer-side intent
classification works — most inbound is classified and logged silently; only
the cases that need Matt's attention surface.

---

## 2. Principles

These shape every design decision below. Push back if any feels wrong.

### 2.1. LLM-first, hard rules second
Where a decision depends on contextual judgment ("is this a callback for the
old job or a new job?", "is this customer asking for an assessment?"), use the
LLM with full conversation context — not a brittle date threshold or keyword
rule. Hard rules are reserved for purely structural decisions ("if event color
is 10, it's a job execution event").

### 2.2. The text interface is the durable product surface
The agent comms line isn't a notification channel bolted onto the side of a
cron system. It's the long-term operational surface that Matt manages the
business through. Every new capability should be reachable through it
("schedule X", "what's status of Y", "stop doing Z"), and every agent action
should be explainable through it. We design for that surface to keep growing
in capability over time as the agent earns more autonomy and learns more of
the business's contextual rules.

### 2.3. Agent as collaborator, not autopilot
Anything ambiguous, anything new, anything below the agent's current trust
threshold for that action type — the agent asks via the comms line. Matt's
response becomes training signal: a confirmation reinforces, a correction
teaches, a "stop doing X" becomes a standing rule.

### 2.4. Graduated autonomy (the trust ladder)
Every action type the agent can perform has a configurable autonomy level
(see §6). The agent starts at "always ask Matt first" for new actions and gets
promoted to "act, then summarize" or "act silently" as Matt confirms its
proposals are consistently right. Never global — always per-action-type.

### 2.5. Deal as the spine
The Pipedrive deal is the **load-bearing primary key for a customer's
engagement around a specific piece of work.** Everything attaches to a deal:
QB estimate, calendar events (assessment + job + callbacks + multi-day
sessions), invoice, payment, project assets (photos for marketing). A deal
has a clear lifecycle. We never manually touch deals — they are entirely
agent-managed.

### 2.6. No manual Pipedrive deal work, ever
Matt's hard rule. If the only way to keep the deal model healthy is for Matt
to manually touch deals, the model is wrong. The agent owns deal CRUD
end-to-end. Matt's only interface to deal state is through the agent comms
channel or by reading the PD UI.

### 2.7. Existing operational principles still hold
- **Filter consistency:** the calendar-event filter is one source of truth
  (extended, not forked) — same rule as `docs/middleware-auto-invoicing.md:24`.
- **No proactive notifications:** the agent comms number is for asks and
  exceptions, not heartbeats or status pings.
- **Middleware is sacrosanct:** every change minimal, deliberate, tested.

---

## 3. Communication architecture

### 3.1. The two lines

| Line | Purpose | Direction |
|---|---|---|
| **Main business line** (existing `QUO_PHONE_NUMBER`) | Customer-facing. Customers text/call this. Currently Mike & Matt see all activity. | Customer ↔ AAC |
| **Agent comms line** — `(617) 766-0151` (currently unused in Quo) | Matt ↔ Agent. The agent's private channel for asking Matt questions and receiving directives. | Matt ↔ Agent |

### 3.2. Inbound routing (NEW behavior)

The Quo webhook (`apps/middleware/api/webhooks/quo.ts`) needs to branch on
the destination line:

- **Inbound to main business line** → existing flow (log to PD, extract
  entities, etc.) + **NEW**: forward signal to agent context for inference
- **Inbound to agent comms line** → treat as a directive from Matt. Parse
  intent ("schedule Jane Doe", "what's the status of the Smith job", "stop
  sending Mike's text", etc.), route to the agent's action layer

The agent comms line **only accepts messages from Matt's personal number**
(other inbound = ignored or logged). This is a hard whitelist, not LLM-based.

### 3.3. Outbound from the agent

| Sender | Recipient | When |
|---|---|---|
| Agent comms line | Matt's personal | Confirmation requests, exception alerts, "I just did X" summaries (when configured) |
| Main business line | Customer | When the agent has earned trust to message customers directly (Run-stage only) |

Quo natively supports multiple numbers per account, and our `QuoClient.sendMessage`
already takes an optional `from` parameter. The only missing piece is
configuring the agent number in env and passing it when the agent is sending
from that line — no client API change needed.

### 3.4. Why a separate line?
- Keeps Matt-agent conversation separate from customer conversation in Quo's
  thread view (no confusion when scanning history)
- Matt's reply to "schedule Jane Doe for Tuesday?" is unambiguously to the
  agent, not accidentally to a customer
- Future-proofs: if we ever want to expose the agent to other team members
  (Mike, salesperson), each can have their own bidirectional channel

---

## 4. Deal model

### 4.1. What a deal represents

**One deal = one customer's engagement around one piece of work.** A customer
who hires us for crack repair has one deal. The same customer 18 months later
hiring us for a sump pump has a *different* deal. A callback for the same
crack repair attaches to the *original* deal.

The phrase "piece of work" is intentionally fuzzy — the LLM disambiguates
based on conversation context (§4.3).

### 4.2. Deal stages (OPEN — Matt to weigh in)

First-cut proposal — these aren't decisions yet:

| Stage | Entered when | Exited when |
|---|---|---|
| `Lead` | First inbound from a stranger (call/text on main line, no existing person) | Person matched to existing customer, OR moves to next stage |
| `Assessment Scheduled` | Purple calendar event (color 5) created | Assessment happens (event date passes) |
| `Assessment Done` | Assessment event date passes, no quote yet | Quote sent, OR aged out |
| `Quote Sent` | QB estimate created (`TxnStatus = Pending`) | Quote status changes |
| `Quote Accepted` | QB estimate `TxnStatus = Accepted` | Job scheduled |
| `Job Scheduled` | Green calendar event (color 10) created | Job date passes |
| `Job Done` | Job event date passes | Invoice created |
| `Invoiced` | QB invoice created | Invoice paid |
| `Paid` | QB invoice `Balance = 0` | Marked Won after warranty window |
| `Won` | (Closed-positive terminal state) | — |
| `Lost` | Estimate rejected, OR aged out at any pre-job stage with no movement | — |

**Open questions for Matt:**
- Is `Lead` worth having, or should deals only open at Assessment Scheduled /
  Quote Sent?
- Is `Won` a separate state from `Paid`, or just `Paid + N days`?
- What's the aged-out timeline for `Lost`? (Probably contextual — LLM should
  judge, not a hard threshold)

### 4.3. Deal creation triggers

Two structural triggers create deals (rare exceptions handled by LLM
judgment, see below):

1. **Purple calendar event created** (color 5, assessment) — ~30% of starts
2. **QB estimate created** — ~70% of starts (the typical Matt-on-laptop path)

**Inbound contact from a stranger does NOT auto-open a deal.** Roughly 40% of
inbound is spam, internal business, or requests for services we don't
provide. The intent classifier (§1.1) must first determine the contact
represents a real opportunity. Only then does the agent propose deal
creation — which may itself be an autonomy-ladder decision (e.g., level 1:
"Looks like a real lead from Smith — open new deal at Assessment Scheduled?").

**Active-deal handling is contextual, not deterministic.** Most of the time,
when a new signal arrives for a customer with an active deal, it belongs to
that deal (assessment → quote → schedule → invoice progression). But
sometimes a customer has two unrelated jobs in flight simultaneously (e.g.,
crack repair in basement AND a separate sump pump quote), and a new signal
might belong to either — or be a third thing entirely.

The agent's default behavior:
- If exactly one active deal exists and context suggests it fits → attach
- If multiple active deals OR context is ambiguous → propose attachment via
  comms line ("Smith just texted 'when are you coming back' — this looks
  like it's about the crack repair deal, not the sump pump quote. Confirm?")
- If no active deal AND intent classifier says "real opportunity" → propose
  new deal creation
- If no active deal AND intent classifier says "not a real opportunity" →
  log and do nothing

The agent should err toward verification when it's not confident. A
false-positive new-deal creation (deal opened when it should have attached)
creates clutter; a false-positive attachment (new signal misrouted to wrong
deal) corrupts the deal's history. Both are recoverable, but the agent
should learn from corrections.

### 4.4. Association rules (LLM-driven, not deterministic)

When a new artifact (calendar event, inbound message, etc.) arrives for a
known customer with multiple deals (active or historical), the agent decides
which deal it belongs to using context:

- The customer's recent message history on the main business line
- The customer's deal history (stages, dates, scope of work)
- The artifact itself (event title, message content)

**Examples the LLM should handle correctly:**

- *"It's still leaking, can you come back?"* sent 3 days after a paid crack
  repair → callback on that deal (no new deal)
- *"Can you guys come back? My basement is flooded again."* sent 6 months
  after a paid sump pump install → callback on that deal (no new deal)
- *"My kitchen ceiling is cracking now"* sent a year after a basement repair
  → new deal (different scope, different problem)
- Matt creates a green calendar event titled "Smith Family — patch repair"
  → if Smiths have one active "Quote Accepted" deal, attach. If two, agent
  asks Matt via comms line which one.

**Fallback:** if ambiguous and the agent isn't confident, SMS Matt with the
ambiguity description and the candidate deals. Matt's reply teaches the agent.
(This is the same multi-estimate-ambiguity pattern we already use in Cron A —
generalized.)

### 4.5. The artifact-to-deal link mechanism

Each artifact type carries a deal reference:

| Artifact | How it carries the deal ID |
|---|---|
| Calendar event | Description includes `[deal:1234]` marker, set at event creation time |
| QB estimate / invoice | PD custom field on the deal stores QB IDs; reverse lookup via deal |
| Quo message thread | PD activity on the deal logs all messages with that customer (already happens, but currently not deal-scoped) |
| PD person | Person can be linked to many deals (one per engagement) |

**`[deal:N]` marker convention:** placed at the end of calendar event
descriptions, format `[deal:1234]`. Agent-created events always include it.
Matt-created events don't, and get matched via LLM association (§4.4) — or,
once trust is high, the agent rewrites the event description to add the
marker after association is confirmed.

---

## 5. Calendar ↔ deal bidirectional link

### 5.1. Event types and their deal relationship

| Color | Type | Deal interaction |
|---|---|---|
| 5 (purple) | Assessment | Opens new deal at `Assessment Scheduled` (if no active deal), or attaches to existing active deal as additional assessment activity |
| 10 (green) | Job execution | Attaches to deal at `Quote Accepted` → advances to `Job Scheduled` |
| 3 (other) | Callback / follow-up visit | Attaches to existing deal (any stage), logs as callback activity |
| (other) | Personal / lunch / non-work | Ignored (existing filter) |

### 5.2. Sync directions

- **Calendar → Deal:** new event detected → identify deal → update deal stage
  / log activity. This is the existing cron pattern, extended.
- **Deal → Calendar:** stage transition → if it implies a calendar event
  should exist (e.g., `Quote Accepted` → `Job Scheduled` requires a green
  event), agent proposes one (stub event creation per MASTER-PLAN 2.5F),
  Matt confirms/adjusts, marker is embedded.

### 5.3. Detection of new events

Currently crons poll Google Calendar daily on a fixed window. The deal-spine
work doesn't require us to change this initially — same daily poll can drive
deal updates. Real-time (calendar push notifications via Google's watch API)
is a later optimization, not required for crawl.

---

## 6. The autonomy ladder

Every agent action type has an autonomy level. Configured per-action, not
global. Stored in env / config, not hardcoded.

| Level | Behavior | Example for "schedule a job" |
|---|---|---|
| 0 — `disabled` | Agent never takes this action | (e.g., we haven't built it yet) |
| 1 — `propose` | Agent identifies opportunity, opens a **conversation** with Matt on the comms line about the proposed action, and acts only after the conversation reaches a committed decision. | "Customer X approved their quote. Want me to schedule next Tuesday 8:30am?" → Matt: "yes" → event created. Or Matt: "make it 9am" → agent revises. Or Matt: "is this for the crack repair or the sump pump?" → agent answers, Matt then decides. |
| 2 — `act-and-notify` | Agent acts, then summarizes what it did. Matt can still push back via comms line and the agent will reverse/adjust. | (Cron A operates here today: creates invoice, no notification because it's a daily silent run) |
| 3 — `act-silently` | Agent acts, logs internally only, no notification | (Cron A would move here once Matt fully trusts it) |

**Important: `propose` is a dialogue, not a confirmation button.** When the
agent proposes, Matt can respond with any of: yes / no / "yes but X" /
clarifying question / counter-proposal / "explain your reasoning." The agent
maintains the proposal as an open conversation state until it resolves to
either committed (act) or cancelled. Especially in Run state, every proposal
should feel like texting a competent assistant, not approving an
auto-generated alert.

**Action types** the spec covers (this is the initial inventory — more
emerge as the system grows, especially as the agent comms line surfaces
new categories of Matt-directed work):

*Deal & calendar lifecycle:*
| Action | Crawl level | Walk level | Run level |
|---|---|---|---|
| Create QB invoice from accepted estimate | 2 (act-and-notify, currently silent because daily summary) | 3 | 3 |
| Send QB invoice to customer | 0 (not yet enabled) | 2 | 3 |
| Open new PD deal | 0 | 1 → 2 | 3 |
| Update PD deal stage | 0 | 2 | 3 |
| Associate new calendar event with existing deal | 0 | 1 (ask if ambiguous) | 2 |
| Create assessment event (purple) from heard intent | 0 | 1 (always ask, even with stated time/place — high blast radius if wrong) | 2 (act for high-confidence cases) |
| Create job event (green) from heard intent | 0 | 1 | 2 |
| Propose calendar event time slot to Matt | 0 | 1 | 2 (act in trusted intent categories) |
| Text customer directly with proposed slots | 0 | 0 | 1 → 2 (per intent category) |
| Send stale-deal nudge text to customer | 0 | 1 (Matt approves each) | 2 (auto-send for trusted patterns; still log) |

*Real-time intent classification & response:*
| Action | Crawl level | Walk level | Run level |
|---|---|---|---|
| Classify inbound customer message intent | 0 | 2 (classification runs silently; agent only escalates when action proposed) | 3 |
| Propose response to customer message via comms line | 0 | 1 (Matt approves before sending) | 2 (auto-send for trusted categories) |
| Detect callback intent and propose action | 0 | 1 | 2 |
| Detect assessment-request intent and propose action | 0 | 1 | 2 |
| Detect quote-approval intent and propose action | 0 | 1 | 2 → 3 |

*Matt-directed write actions via agent comms line:*
| Action | Crawl level | Walk level | Run level |
|---|---|---|---|
| Execute scheduling directive ("schedule X for Tuesday") | 0 | 1 (confirm slot back to Matt) | 2 |
| Apply standing rule ("stop doing X going forward") | 0 | 1 (confirm rule captured) | 2 |
| Reverse a recent agent action on Matt's request | 0 | 1 (confirm reversal before acting) | 2 |

*Self-diagnostic middleware ops (§1.4):*
| Action | Crawl level | Walk level | Run level |
|---|---|---|---|
| Detect a middleware error and surface to Matt | 2 (act-and-notify — text Matt the raw failure context as soon as it's logged, no diagnosis yet) | 2 (now with agent-written diagnosis attached) | 2 |
| Diagnose root cause of a logged failure | 0 | 1 (agent runs diagnosis, presents findings; Matt confirms before any fix) | 2 (diagnosis included in the same SMS that surfaces the error) |
| Apply an idempotent ops fix (re-run sync, repair Redis mapping, set a missing PD custom field) | 0 | 1 (Matt explicitly approves each fix) | 2 (auto-apply for fix patterns Matt has approved before; still texts what it did) |
| Propose a code-level fix (patch, PR) | 0 | 1 (always — code changes are a deploy) | 1 (always — code changes are a deploy) |

*Matt-directed read queries via agent comms line* (these are read-only, so
they don't pass through the autonomy ladder the way writes do — they always
just answer; the question is whether the capability exists at all):

| Query category | Crawl | Walk | Run |
|---|---|---|---|
| Single-entity status ("status of Smith deal?") | — | available | available |
| Reasoning explanation ("why did you skip Lori?") | — | available | available |
| Cross-entity integrity check ("any jobs today without invoices?") | — | available | available |
| Fuzzy lookup ("the Rockland client from last week, phone?") | — | available | available |
| Aggregate reporting ("how many jobs in June? deal flow shape?") | — | available | available |
| Conversation history recall ("did Smith reply to my quote?") | — | available | available |
| Financial summaries from QB ("how much did we invoice in April?") | — | partial (basic) | full |

The agent's read-access is foundational and is built in walk-stage as a
unified tool surface (see §7.2 milestone #2 + §8.2). Once those tools exist,
the LLM can chain them to answer essentially arbitrary questions about
business state.

**Promotion mechanism (TBD):** how does an action move up the ladder?
Probably: Matt explicitly tells the agent ("you can stop asking about
invoice creation, just do it") via the comms line. Not automated — Matt's
explicit trust decision.

---

## 7. Phased rollout

### 7.1. Crawl (next 2-4 weeks of work)

**Goal:** the deal becomes the spine. No customer-facing automation yet.

1. **Add PD deal CRUD to the api-clients package** (currently zero deal
   methods exist). Methods: `createDeal`, `updateDeal`, `getDeal`,
   `getDealsByPerson`, `addDealStage` if needed. Tests.
2. **Define deal stages** in PD (Matt does this in the PD UI based on §4.2
   after we agree).
3. **Wire the agent number through env + wrap Quo's conversation API.** Add
   `QUO_AGENT_PHONE_NUMBER` env var; pass it as `from` from agent code paths
   (no `QuoClient` API change needed). Separately, wrap Quo's List
   Conversations / messages endpoints in `QuoClient` so the customer context
   builder has real conversation data.
4. **Add `[deal:N]` marker support to existing crons.** Job-reminders,
   job-followups, invoice-create, invoice-send: prefer marker if present;
   fall back to current name-match logic. (Solves the typo problem
   immediately for any event the agent has tagged.)
5. **Backfill: run a one-shot script** that creates a PD deal for every
   currently-open QB estimate + every recent green calendar event, so the
   deal model has data on day 1.
6. **Deal-update cron**: nightly job that reconciles QB estimate/invoice
   state into deal stages.
7. **Error-surfacing tick** (first crawl-stage piece of §1.4) — periodic job
   that reads new entries from the `logHealthError` stream and texts Matt
   the raw failure context from the agent line. No diagnosis yet, just
   better routing than waiting for Matt to check `/api/health`. Also
   instruments existing error sites to make sure they all funnel through
   `logHealthError` (today some failures `log.error` but skip the health
   log, e.g., a rejected `Promise.allSettled` branch in the Pipedrive
   webhook — those need patching).

### 7.2. Walk (~1-2 months after crawl)

**Goal:** the agent comms line is live. Agent proposes; Matt confirms.

1. **Agent comms inbound handler** — route messages on `(617) 766-0151` to
   an "intent router" that parses Matt's directives.
2. **Agent read-access tool surface** — the foundation for both
   per-customer context-building AND arbitrary cross-entity queries from
   the comms line. A set of LLM tools (function-calling) the agent invokes
   to answer questions and assemble context. First-cut tool surface:
   - `getCustomerContext(personIdOrPhone)` — bundles PD person + deals +
     recent Quo conversation + recent calendar events
   - `searchCalendar({dateRange, locationKeyword?, color?})` — for fuzzy
     lookups by date, location, event type
   - `listDeals({stage?, personId?, dateRange?})` — deal flow queries
   - `getDeal(dealId)` — full deal state including linked QB, calendar,
     Quo references
   - `findJobsMissingInvoices({dateRange})` — integrity check pattern
   - `getInvoiceSummary({dateRange})` — financial aggregates from QB
   - `searchConversation(personId, searchText?)` — recall what was said
   The LLM chains these to answer any reasonable question Matt asks.
3. **Real-time intent classification** (generalizes MASTER-PLAN 2.5E) — every
   inbound customer signal (text, call transcript) is fed through the LLM
   with customer context. Initial categories: quote approval, assessment
   request, scheduling negotiation, callback, pricing question, complaint,
   unclassified. Each category routes to a downstream action proposal.
   "Approval detection" is one classifier output, not the whole stage.
4. **Action proposals via agent comms** — for each classified intent, the
   agent texts Matt with the proposed next action and reasoning. Examples:
   - *"Smith's text reads like quote approval — open Quote Accepted and
     propose Tue 8:30am?"*
   - *"Jones asked to come look at his foundation — open new Lead deal and
     propose an assessment Wed afternoon?"*
   - *"Wilson said 'still leaking' 4 days post-job — propose callback this
     Friday morning?"*
5. **Stub event creation on confirm** (MASTER-PLAN 2.5F) — when Matt
   confirms, agent creates the calendar event with the `[deal:N]` marker
   embedded. Two flavors:
   - **Job events (green, color 10)** — triggered by quote-approval intent.
   - **Assessment events (purple, color 5)** — triggered by
     assessment-request intent. Two sub-modes: (a) Matt provided time/place
     in conversation ("we'll come Tuesday 9am") → agent extracts and creates
     event; (b) Matt deferred ("I'll get back to you") → agent runs the slot
     algorithm and proposes back to Matt.
   - Algorithm for slot suggestion is the first-cut version of §9.
6. **Stale-deal nudges** — agent monitors deals that have stalled (e.g.,
   estimate sent but no movement after some contextual window) and proposes
   a nudge text to the customer. "Stale" is contextual, not a fixed
   threshold — agent considers the customer's typical response pattern,
   deal scope, and prior interactions. Applies to multiple stages: stale
   quotes awaiting response, stale assessments awaiting quote, stale
   invoices awaiting payment. Each nudge is a proposal Matt confirms (or
   edits) before sending.
7. **Agent comms outbound from Matt** — Matt can text the agent comms line
   with directives: status queries, schedule overrides, standing rules.
   Initial directive surface is small: status query for a customer/deal,
   manual schedule of an event, "stop" / "pause" on a specific behavior.
8. **Diagnostic agent for middleware errors** (§1.4) — every new entry in
   the error stream gets handed to the diagnostic agent. The agent runs a
   diagnosis using the read-access tool surface (§7.2.2), proposes either
   an idempotent ops fix or a code-level fix, and texts Matt with the
   structured writeup. Matt converses to ask follow-ups or approve. Ops
   fixes execute on approval; code fixes get drafted as a PR/patch for
   Matt to review out-of-band.

### 7.3. Run (long-term, multi-quarter)

**Goal:** the agent is the operational nervous system. Matt manages the
business primarily through the agent comms line. Well-worn patterns happen
autonomously; novel situations get proposed; standing rules learned via the
text channel are applied.

1. **Customer-facing slot suggestions** — for high-trust intent categories
   (scheduling after quote approval, callbacks within warranty window), the
   agent texts the customer directly with 2-3 proposed slots and processes
   the reply end-to-end.
2. **Expanded directive surface on the agent comms line** — Matt can ask
   the agent richer questions ("what's pending this week?", "summarize Smith
   deal", "draft a response to Davis's last text"), set standing rules
   ("don't text commercial customers review prompts"), and override agent
   defaults conversationally.
3. **Standing-rule memory** — corrections and rules from Matt persist as
   structured constraints the agent applies going forward. Surface for
   reviewing and editing standing rules.
4. **Geo-clustering algorithm matured** — proximity to existing scheduled
   jobs factored into slot suggestions (§9), including the salesperson hire's
   schedule.
5. **Project staging** (MASTER-PLAN 2.5G) — completed jobs auto-stage assets
   for the website and marketing engine.
6. **Deal lifecycle attribution** — wired to the attribution pipeline
   (Pipedrive is attribution source of truth per existing memory).
7. **Multi-channel signal integration** — beyond text and call, the agent
   could ingest QB events, calendar changes, and GBP review activity as
   first-class signals (each generates intent-classification → action).
8. **Auto-application of well-worn ops fixes** (§1.4) — diagnostic patterns
   the agent has applied successfully N times with Matt's approval get
   promoted to level 2 (act-and-notify). The agent fixes the immediate
   instance and texts a "did this" summary instead of asking. Code-level
   fixes never auto-apply.

---

## 8. Build inventory (what's net-new)

Cross-referenced with the infrastructure survey from 2026-05-19.

### 8.1. `@aac/api-clients` additions
- **Pipedrive deal CRUD methods on `PipedriveClient`** — PD's API supports
  deals fully; our client wrapper currently exposes zero deal methods. Add
  `createDeal`, `updateDeal`, `getDeal`, `getDealsByPerson`, and deal-stage
  helpers, with tests.
- **Quo conversation methods on `QuoClient`** — Quo's API has List
  Conversations / list messages endpoints we haven't wrapped. Add
  `listConversations`, `getConversation`, `listMessages(conversationId)` (or
  whatever shape matches their API), with tests. Powers the customer context
  builder.
- **No `sendMessage` API change needed** — Quo supports multiple per-account
  numbers natively, and `sendMessage(to, text, from?)` already accepts a
  `from` override. We just wire the agent number through env config and pass
  it when needed.
- (No Gemini changes needed initially — existing `generateContent` is enough
  for intent inference)

### 8.2. `apps/middleware` additions
- **`lib/agent-tools/`** — the agent's read-access tool surface (see §7.2
  walk #2). One file per tool category: `customer.ts`, `calendar.ts`,
  `deals.ts`, `invoices.ts`, `conversation.ts`. Each exports LLM-callable
  functions with strict JSON-schema inputs/outputs.
- **`lib/agent-runtime.ts`** — the conversational agent loop: takes an
  inbound message (from customer signal OR from Matt directive), assembles
  context, runs the LLM with the tool surface, returns either an action
  proposal, a query answer, or a write action to execute.
- **`lib/intent-router.ts`** — first-pass classifier on inbound messages to
  decide whether this is a customer signal needing intent classification,
  a Matt directive needing routing, or a query needing an answer.
- **`lib/deal-association.ts`** — given a new artifact and a customer's deal
  history, returns which deal to attach to (LLM-backed via agent-runtime
  with a constrained tool set, with fallback to "ask Matt").
- **`lib/proposal-state.ts`** — persistent state for in-flight proposals
  (pending / awaiting-info / committed / cancelled). Lets the agent maintain
  a multi-turn conversation about a proposal across SMS exchanges.
- **`api/webhooks/quo.ts` extension** — branch on destination line; route
  customer-line traffic through real-time intent classification, agent-line
  traffic through agent-runtime as a Matt directive.
- **`api/cron/deal-reconcile.ts`** — nightly reconciliation of QB ↔ deal state.
- **`api/cron/agent-tick.ts`** (TBD) — periodic agent scan for "did anything
  happen recently that I should propose action on?" (e.g., stale-deal
  detection).
- **`api/cron/error-tick.ts`** (§1.4) — periodic scan over recent
  `logHealthError` entries. Crawl-stage version: text raw failure context
  to Matt. Walk-stage version: hand each new error to the diagnostic agent
  before texting. Run-stage version: auto-apply trusted ops fixes before
  the SMS goes out.
- **`lib/diagnostic-agent.ts`** (§1.4, walk stage) — given an error record
  and the read-access tool surface, produces a structured diagnosis +
  proposed-fix object. Output is consumed by the error-tick cron to format
  the SMS to Matt.
- **Error-source instrumentation audit** — sweep the middleware for sites
  that `log.error` but skip `logHealthError`, and patch them so every
  failure mode is observable through one stream. (The Pipedrive webhook's
  `Promise.allSettled` rejection branches are the known example from the
  2026-05-20 Nick Puccio trace.)

### 8.3. Configuration additions
- `QUO_AGENT_PHONE_NUMBER` env var = `(617) 766-0151`
- `MATT_PERSONAL_PHONE_NUMBER` env var = whitelist for agent comms inbound
- Autonomy levels config (file or env, per action type)

### 8.4. Pipedrive setup (manual, Matt)
- Define deal stages in PD UI matching §4.2
- Add custom field on Deal: "QB Estimate ID" (text)
- Add custom field on Deal: "QB Invoice ID" (text)
- Add custom field on Deal: "Google Calendar Event IDs" (text, comma-sep)

---

## 9. Slot-suggestion algorithm (sketch for the Run stage)

Captured from Matt's vision so the deal-spine work doesn't preclude it.
NOT in scope for crawl or walk — but the data model needs to support it.

### Inputs
- Customer's job location (address from PD person or QB customer)
- Job size bucket (quick / half-day / full-day / multi-day)
- Existing scheduled calendar events in the next 2-4 weeks
- Base location: 30 Ranthor Lit Street, Quincy (hardcode for now)

### Constraints
- Weekdays only by default
- Two slots/day: 8:30am (morning), 1:00pm (afternoon)
- Half-day jobs: one slot
- Full-day: both slots of one day
- Multi-day: consecutive days
- Quick (2hr): can be combined with another quick

### Scoring
- Prefer days that already have a job nearby (geo-cluster bonus)
- Prefer earliest available (sooner = better)
- Penalize days that would force a long-distance trip on an otherwise empty day

### Output
- Top 3 candidate slots with rationale

**Open questions for Matt:**
- Are there days of the week we avoid (e.g., never schedule Friday because
  of weekend buffer)?
- Is there a max-jobs-per-day cap regardless of geo?
- How does the salesperson hire (Dec 2025) change this model — does the
  algorithm need to allocate between Mike and the salesperson?

---

## 10. Open questions / decisions needed

Before any code is written, these need Matt's input:

1. **Promotion mechanism for autonomy** — Matt-explicit only, or also some
   automated suggestion ("hey, I've been right 20 times in a row on this
   action, want to bump me to act-silently?")
2. **Agent-comms line directive format** — natural language only, or also a
   slash-command shorthand for common ops?
3. **Backfill scope** — how far back do we create deals retroactively? Just
   open QB estimates? Also recent paid invoices for historical attribution?
4. **Matt's personal phone for whitelist** — where stored, how rotated?
5. **What does the agent do when Matt doesn't reply?** Timeout behavior on
   pending proposals — silent skip after N hours? Re-ping? Carry over to
   next day? Different per action urgency?
6. **Stale-deal nudge tuning** — even though "stale" is LLM-judged, we
   probably need some minimum window before the agent even considers
   nudging (don't ping the customer 24h after sending an estimate). What's
   the floor? 48h? 5 days? Should it vary by stage?

---

## 11. Out of scope (for this spec)

- Customer-facing AI conversations on the main line (Run-stage, separate spec)
- Image generation / marketing automation (separate pillar)
- Multi-technician scheduling (treat all techs as fungible until salesperson
  hire is fully integrated)
- Replacing Quo as the SMS provider
- Migrating away from Pipedrive

---

## 12. Decisions log

- **Deal-as-spine is the strategic frame** (2026-05-19, Matt). Pipedrive
  deals will be promoted to load-bearing infrastructure, agent-managed only,
  never manually touched.
- **Agent comms via dedicated Quo line `(617) 766-0151`** (2026-05-19,
  Matt). Separate from customer-facing main line.
- **LLM inference over hard rules** for ambiguity (2026-05-19, Matt).
  Rejected the "Paid + 30 days = closed, callbacks open new deal" rule
  because real callbacks happen contextually (3 days OR 6 months).
- **Graduated autonomy per action type** (2026-05-19, Matt). No global
  autonomy setting; each action type has its own trust level that Matt
  promotes explicitly.
- **No proactive notifications** continues to hold (carried from
  `feedback_no_proactive_notifications`). Agent comms is for asks and
  exceptions only — no heartbeats or status pings.
- **`propose` is a dialogue, not a confirmation button** (2026-05-19, Matt).
  Proposal-stage actions must support full conversational interaction:
  yes / no / "yes but X" / questions / counter-proposals. Especially in
  Run state, this should feel like texting a competent assistant.
- **Deal stages accepted as proposed in §4.2** (2026-05-19, Matt) — including
  `Lead`, `Won` separate from `Paid`, and contextual aged-out for `Lost`.
- **Stranger inbound does NOT auto-open a deal** (2026-05-19, Matt). ~40%
  of inbound is non-opportunity (spam, internal, out-of-scope services).
  Intent classifier must qualify first, then agent proposes deal creation.
- **Multi-active-deal disambiguation is LLM-driven with verification**
  (2026-05-19, Matt). When the agent can't confidently route a signal to
  one of multiple active deals (or distinguish new vs existing), it
  proposes via comms line rather than guessing.
- **Stale-deal nudges added as a first-class agent action** (2026-05-19,
  Matt). Covers stale quotes, assessments, and invoices. "Stale" is
  contextual per customer, with a minimum floor TBD (§10 Q6).
- **Assessment events (purple, color 5) auto-creation is symmetric with
  job events (green, color 10)** (2026-05-19, Matt). Agent infers from
  conversation that an assessment was promised, then either uses
  Matt-provided time/place or runs the slot algorithm to propose.
- **Agent comms line is a full read-access query interface, not just a
  write/approval channel** (2026-05-19, Matt). Matt can ask the agent
  arbitrary questions about business state: fuzzy lookups, integrity
  checks, aggregate reporting, conversation recall, financial summaries.
  Built on a unified tool surface the LLM chains together.
- **Middleware errors are first-class agent signals, not just log lines**
  (2026-05-20, Matt). All `logHealthError` calls feed the diagnostic agent
  (walk+) rather than waiting for Matt to inspect `/api/health`. Agent
  diagnoses, proposes a specific ops or code fix, and texts Matt with the
  "we noticed X, we looked into it, here's what we found, ask questions or
  approve the fix" framing. Crawl-stage version surfaces raw errors via
  SMS without diagnosis. Triggered by the 2026-05-20 Nick Puccio trace
  where a Pipedrive→Quo sync timeout was killed silently by Vercel and
  never reached the health endpoint.
