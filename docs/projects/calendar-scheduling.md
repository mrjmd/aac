# Project Spec — Calendar Scheduling Automation

**Status:** Spec stub — depends on apps/agent crawl
**Owner:** Matt
**Created:** 2026-05-27
**Build dependency:** apps/agent crawl (PD deal CRUD + read-tool surface + comms line) must exist first.

---

## Goal

Eliminate the manual "create calendar event for new job" tedium. When an
estimate is accepted, the agent:

1. Detects the QB estimate status change (Pending → Accepted)
2. Reads conversation context (Quo thread; any time/place commitment from customer)
3. EITHER extracts an explicit time ("Tuesday 9am works") AND creates the calendar event directly
4. OR runs the slot-suggestion algorithm and proposes 2-3 slots back to Matt via comms line, then Matt confirms
5. Creates the calendar event with `[deal:N]` marker embedded in description
6. Updates deal stage to `Job Scheduled`

Customer-facing slot proposals (agent texts customer directly) are deferred
to Run-stage of apps/agent (trust threshold not yet earned).

## MVP scope (after apps/agent crawl ships)

- QB webhook listener for estimate-status-change events (or polling cron if webhooks unavailable)
- Intent classifier: "did the customer commit to a time?" — read recent Quo thread
- Two flavors:
  - **Time-extracted:** customer said "Tuesday 9am" → create event, confirm to Matt
  - **No time:** run slot algorithm, propose to Matt with 2-3 options
- Slot algorithm: see original Phase 2.5 spec §9 for sketch (base location, weekday-only, 8:30am / 1:00pm slots, geo-cluster bonus, job-size buckets)

## Open questions for Matt

1. **Slot algorithm parameters** — avoid Fridays? max-jobs-per-day cap? salesperson-vs-tech allocation?
2. **Pre-acceptance flow:** should the agent also create an assessment event (purple/5) before quoting? Original spec said yes (symmetric with job-event creation). Defer until base case works.
3. **What about jobs scheduled before estimate exists?** (Walk-in / inbound emergencies.) Slot suggestions then happen on demand from agent comms ("schedule Davis for tomorrow morning").

## Phasing

| Phase | Scope |
|---|---|
| 1 | QB Accepted detection → notify Matt with deal context (no event creation yet) |
| 2 | Time extraction from conversation → propose event creation → Matt confirms → event created |
| 3 | Slot algorithm + propose 3 options when no time stated |
| 4 | Geo-clustering refinement |
| 5 (Run-stage) | Customer-facing slot proposals via main line |

## Related

- Original detailed spec: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` §5 + §9 (slot algorithm details)
- Architecture decisions: `docs/DECISIONS.md`
- Plan position: priority #3; depends on apps/agent crawl
- Current plan: `docs/PLAN.md`
