# Project Spec — apps/agent (Conversational Agent Platform)

**Status:** Spec — pre-build
**Owner:** Matt
**Created:** 2026-05-27
**Pillar:** 6 (apps/agent/)
**Supersedes:** `_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` — the original 44k-byte spec remains the most-detailed design source. Refer to it for nuanced design decisions not captured in this spec.
**Build dependency:** Foundational. Required by Calendar Scheduling and Quote Auto-Draft projects. apps/field v1 is independent; apps/field v2 depends on this.

---

## Goal

A separate Vercel app that provides the agent platform — conversational
operations runtime, deal spine, LLM read-tool surface, diagnostic agent —
that the original Phase 2.5 deal-spine spec proposed as middleware extensions.

Split out per the 2026-05-27 architecture decision because middleware is
sacrosanct (minimal changes, stateless webhook processing) and the agent
platform has different change cadence, state model, and runtime profile.

## Crawl / Walk / Run rollout (compressed from original Phase 2.5 spec)

### Crawl (2-4 weeks — foundation)

1. **App scaffold** — Next.js 15 deploy, shared Redis, env config including `QUO_AGENT_PHONE_NUMBER` = `(617) 766-0151` and `MATT_PERSONAL_PHONE_NUMBER` for whitelist
2. **PD Deal CRUD methods in `@aac/api-clients`** — `createDeal`, `updateDeal`, `getDeal`, `getDealsByPerson`, deal-stage helpers, with tests. Currently zero deal methods exist in the shared client.
3. **Quo conversation methods in `@aac/api-clients`** — `listConversations`, `getConversation`, `listMessages` (or whatever shape matches Quo's API). Powers the customer-context builder.
4. **`[deal:N]` marker support added to existing middleware crons** — `job-reminders`, `job-followups`, `invoice-create`: prefer marker if present, fall back to current name-match. Tiny middleware change, big robustness win. Cross-cutting; the marker-emission lives in apps/agent and middleware reads.
5. **Backfill script** — one-shot creating PD deals for every currently-open QB estimate + every recent green calendar event. So the deal model has data on day 1.
6. **Nightly deal-reconcile cron** in apps/agent — reconciles QB estimate/invoice state into deal stages.
7. **Error-surfacing tick** — periodic job reading new `logHealthError` entries from middleware's stream, texting Matt the raw failure context from the agent line. Crawl version: no diagnosis, just better routing than waiting for Matt to check `/api/health`. (See Walk for the diagnostic-agent layer.)

### Walk (1-2 months after crawl)

1. **Agent comms inbound handler** — routes messages on `(617) 766-0151` to the intent router that parses Matt's directives.
2. **Agent read-access tool surface** — LLM-callable functions for cross-system queries:
   - `getCustomerContext(personIdOrPhone)`
   - `searchCalendar({dateRange, locationKeyword?, color?})`
   - `listDeals({stage?, personId?, dateRange?})`
   - `getDeal(dealId)`
   - `findJobsMissingInvoices({dateRange})`
   - `getInvoiceSummary({dateRange})`
   - `searchConversation(personId, searchText?)`
   The LLM chains these to answer arbitrary Matt questions ("any jobs today without invoices?", "how much did we invoice in April?", "summarize Smith deal").
3. **Real-time intent classification** — every inbound customer signal (text, call transcript) classified into: quote-approval, assessment-request, scheduling-negotiation, callback, pricing-question, complaint, unclassified.
4. **Action proposals via agent comms** — for each classified intent, agent texts Matt the proposed next action with reasoning; Matt confirms via dialogue (not button).
5. **Stub event creation on confirm** — agent creates calendar events with `[deal:N]` marker after Matt confirms intent classification. Two flavors: job (green/10), assessment (purple/5).
6. **Stale-deal nudges** — agent monitors deals stalled in any stage (quote, assessment, invoice) and proposes nudge text. "Stale" is LLM-judged, not threshold-based.
7. **Agent comms outbound from Matt** — directive surface: status queries, schedule overrides, standing rules ("stop sending review prompts to commercial customers").
8. **Diagnostic agent for middleware errors** — every new entry in middleware's error stream → diagnostic agent runs diagnosis using read-tool surface → proposes idempotent ops fix OR code-level fix → texts Matt structured writeup ("we noticed X, looked into it, here's the fix, approve?").

### Run (multi-quarter, long-term)

1. Customer-facing slot suggestions (agent texts customers directly with 2-3 proposed slots)
2. Expanded directive surface ("draft response to Davis's last text", "summarize Smith deal")
3. Standing-rule memory (persistent constraints from Matt's corrections)
4. Geo-clustering algorithm matured (proximity scoring in slot suggestions, including salesperson schedule)
5. Project staging integration (completed jobs auto-stage assets for marketing)
6. Multi-channel signal integration (QB events, calendar changes, GBP reviews as first-class signals)
7. Auto-application of well-worn ops fixes — level 2 (act-and-notify) for diagnostic patterns Matt has approved N times

## Autonomy ladder

Each action class has its own autonomy level. No global flag.

| Level | Behavior |
|---|---|
| 0 — disabled | Agent never takes this action |
| 1 — propose | Agent opens conversation with Matt; acts only after dialogue resolution |
| 2 — act-and-notify | Agent acts, summarizes after; Matt can reverse via comms line |
| 3 — act-silently | Agent acts, logs internally only |

**`propose` is a dialogue, not a button.** Matt's response can be: yes / no / "yes but X" / clarifying question / counter-proposal / "explain your reasoning." Especially in Run state, every proposal should feel like texting a competent assistant.

**Promotion mechanism:** Matt explicitly tells the agent ("you can stop asking about invoice creation, just do it"). Not automated.

See the original Phase 2.5 doc (`_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` §6) for the full per-action-type autonomy table covering deal lifecycle, intent classification, Matt-directed writes, diagnostic ops, and read queries.

## Architecture decisions locked

- Separate Vercel app, not middleware extension (2026-05-27, see `DECISIONS.md`)
- Comms line: `(617) 766-0151` (dedicated Quo number, currently unused)
- Whitelist on Matt's personal number (env: `MATT_PERSONAL_PHONE_NUMBER`)
- Deal as spine: PD deals are load-bearing infrastructure, agent-managed only, Matt never touches deals manually
- LLM-first, hard rules second (per original Phase 2.5 principle 2.1)

## Open questions

1. **Stack: Next.js 15 (matches command-center) OR something lighter (Hono, raw Vercel functions)?** Agent runtime is mostly API + cron, minimal UI. Could justify lighter stack.
2. **Standing-rule storage:** Redis with structured schema, or a small Postgres / Turso? (Original spec was vague.)
3. **Comms line — provision new number OR repurpose `(617) 766-0151` which is already in Quo unused?** Spec says repurpose.
4. **PD deal stages — final list?** Original spec proposed: Lead → Assessment Scheduled → Assessment Done → Quote Sent → Quote Accepted → Job Scheduled → Job Done → Invoiced → Paid → Won → Lost. Confirm with Matt.
5. **Backfill scope:** how far back to create deals retroactively? All open estimates + green calendar events? Past 6 months? (Original spec said "open QB estimates + every recent green calendar event.")
6. **Diagnostic agent — code-fix output format?** If a code-level fix is proposed, does the agent draft a PR, output a diff, or just text Matt the fix description?

## Related

- Original detailed spec: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` (44k bytes — refer for nuance on autonomy table, deal stages, association rules, slot algorithm)
- Architecture decisions: `docs/DECISIONS.md` (2026-05-27 entries on apps/agent split + deal-spine prerequisite)
- Plan position: priority #2 of four; foundational for #3 and #4
- Pillar CLAUDE.md: `apps/agent/CLAUDE.md`
- Current plan: `docs/PLAN.md`
