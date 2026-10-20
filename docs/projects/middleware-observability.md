# Middleware Observability — Real Signal When Things Break

**Written:** 2026-10-19, the night Quo silently disabled the middleware webhook
and Matt found out from Quo's courtesy email instead of from his own systems.
**Goal:** when something business-critical breaks, Matt gets ONE text that says
what broke, what it means, and what to do — within minutes, not at the next
morning's triage, and never because a vendor noticed first.
**Anti-goal:** noise. Alerts that cry wolf get ignored; this design treats
every text as spending trust.

---

## 1. The incident that motivated this (gap analysis)

On 2026-10-19 ~9:19pm ET, a customer's scheduling reply triggered the quo
webhook's heaviest path (intent classification → suggestSlot → calendar).
Middleware processed it **successfully** — but slower than Quo's delivery
timeout. Quo marked the delivery failed, its retries also timed out, and it
auto-disabled the entire webhook. For the next hour, zero Quo events reached
middleware.

Why nothing fired:

| Defense | Why it was blind |
|---|---|
| `logHealthError` → `health:errors` → agent error-surface SMS (every 10 min) | Nothing **threw**. The handler succeeded; it was just slow. This pipeline only sees caught exceptions. |
| `/api/health` metrics (webhookLast, counts) | Nothing reads them continuously. They're pull-only — a dashboard nobody was looking at on a Sunday night. |
| Triage dashboard (launchd 08:15) | Right idea, wrong latency — would have surfaced it ~10 hours later. |
| Middleware itself | After the disable, events simply stopped arriving. **Absence of signal is invisible from inside the system.** |

Three distinct failure classes fell through:
1. **Silent degradation** — slow paths, hangs, timeouts. Nothing throws.
2. **External state changes** — a vendor disables a webhook, a token gets
   revoked, Vercel has an incident. Middleware can't see its own death.
3. **Dead jobs** — a cron or launchd runner stops running. No error, no run.

The existing error-surface pipeline handles only class 0: **caught
exceptions**. It works (verified in code review tonight: 10-min cron, dedup
by fingerprint, 5-SMS/tick cap, cursor semantics are sound). Keep it; build
around it.

---

## 2. The alert contract (signal vs. noise)

Every alert is one of three tiers. The tier decides the channel and latency.

### P1 — text Matt NOW (agent line, any hour)
A business-critical **pipe** is down. Definition: customer messages, money,
or the calendar are not flowing, and waiting until morning loses real work.

- Quo→middleware pipe broken (webhook disabled / endpoint erroring / Vercel down)
- QB OAuth dead (quoting + invoicing blocked)
- Google OAuth dead (stubs, reminders, enrichment blocked)
- A daily cron missed its window entirely (job-reminders didn't run by 9am ET)
- A local launchd runner has been dead >1h (message-drafts, quote-shadow)

Format: what broke + since when + customer impact + the fix runbook in one
text. Example:
> ⚠️ Quo→middleware pipe DOWN since 9:19pm (last processed event 68 min ago;
> Quo shows newer activity). Likely webhook auto-disabled. Fix: Quo dashboard
> → Settings → Webhooks → AAC Middleware Monorepo → re-enable. Incoming texts
> are NOT syncing to PD meanwhile.

Rules: one text per distinct condition per 6h (fingerprint dedup — exists).
One "✅ recovered" text when the condition clears, then silence.

### P2 — same-day visibility, no midnight texts
Degraded but flowing: repeated same-fingerprint handled errors (≥3/hour),
Gemini fallbacks active, webhook p95 latency sustained over threshold.
Channel: error-surface SMS during 8am–9pm only; outside that window, queued
into the morning triage dashboard's new **System health** section.

### P3 — triage dashboard only
One-off handled errors (already retried/recovered), canary results, dedup'd
repeats, latency stats. Never texted.

**The noise contract:** no alert on anything that self-healed; no per-event
texts; no "FYI" texts ([[feedback_no_proactive_notifications]] — exceptions
and anomalies only). If a week of alerts contains one false positive, the
threshold was wrong — fix the threshold, don't make Matt triage it.

---

## 3. The four layers

### Layer A — Outside-in watchdog (NEW — the centerpiece)

A local launchd job (`com.aac.watchdog`, every 5 min, `tools/src/watchdog/`)
on Matt's machine — an observer **independent of Vercel**, so it survives
everything short of the laptop being off. It texts Matt **directly via the Quo
API** from the agent line (not through the Vercel error-surface pipeline,
which shares fate with what it's watching). Local JSON state for dedup +
recovery detection.

Detectors, in value order:

1. **Pipe freshness (the one that catches tonight's class).** Compare source
   truth vs sink truth: newest Quo activity timestamp (Quo API
   `conversations updatedAfter`, org-wide) vs middleware
   `/api/health` → `webhooks.quo.lastProcessed`. If Quo shows activity ≥15
   min newer than the last processed event → P1. This is cause-agnostic: it
   fires for webhook disablement, endpoint 500s, signature breakage, Vercel
   outage, DNS — anything that severs the pipe. (PD pipe: same idea using PD
   recent-activity vs `webhooks.pipedrive.lastProcessed`, 60-min threshold —
   lower traffic. QB: covered by the daily `qb-reconcile` cron instead.)
2. **Cron cadence.** Read `trackCronRun` stamps vs expected schedules
   (job-reminders daily 12:00 UTC, invoice crons, qb-reconcile, agent
   error-surface every 10 min — watching the watcher that watches
   exceptions). Missed window → P1 for reminders/invoices, P2 otherwise.
3. **Launchd runner heartbeats.** Each local runner (message-drafts,
   quote-shadow, triage collector) SETs `keys.heartbeat('<name>')` at tick
   end (one line each). Watchdog alerts when stale >1h → P1. Today a dead
   launchd job is discovered only when Matt notices drafts stopped.
4. **Health endpoint reachability.** `/api/health` unreachable or unhealthy
   → P1 (Vercel-level outage).

Who watches the watchdog? The error-surface cron (Vercel side) gets one added
check: watchdog heartbeat stale >30 min → single SMS "watchdog offline
(laptop asleep?)" during daytime hours only. Two independent observers each
covering the other; any single failure is still caught.

### Layer B — Ack-fast / process-after (kills the silent-degradation class)

`/api/webhooks/quo` restructure: verify signature → dedup-claim → persist the
raw event → **return 200** (sub-second), then run the existing processing via
`waitUntil` within the same invocation (maxDuration already 300s). Failures
in deferred work `logHealthError` exactly as today — nothing gets quieter;
deliveries just stop being hostage to processing time. Same change later for
the PD webhook (same class, PD also disables after repeated failures —
Sacrosanct rules apply: minimal diff, full unit tests, one webhook at a time.)

Design detail that matters: dedup must be claimed BEFORE the 200, so a Quo
retry racing the deferred work can't double-process.

### Layer C — Close the capture gaps (small, mechanical)

- Local runners (`message-drafts`, `quote-shadow`, triage collector,
  drafter) currently fail only into local runlogs — invisible. Wrap each
  `main()` with a catch that ALSO writes `health:errors` (shared Redis,
  existing key, existing SMS pipeline picks it up free) with
  `source: 'launchd:<job>'`. Crash-looping runners become P2 texts
  automatically via the existing fingerprint dedup.
- Audit `logHealthError` coverage in middleware for swallowed catches
  (the `.catch(() => null)` pattern) — each either logs or gets a comment
  saying why silence is correct.

### Layer D — Diagnosis quality (Walk phase, later)

The existing vision ([[feedback_errors_as_diagnostic_agent_signals]]): an LLM
wraps P1/P2 alerts with diagnosis + proposed fix before texting. Crawl-phase
texts (this doc) are raw but carry the runbook line. Do not block Layers A–C
on this.

---

## 4. What this does NOT include (deliberately)

- **No third-party monitoring SaaS** (Sentry, Better Uptime, etc.). The
  watchdog is ~200 lines reusing existing clients; a vendor adds spend,
  another dashboard, and another webhook to break. Revisit only if the
  laptop-as-observer assumption stops holding.
- **No log drains / APM.** Vercel log retention is a non-problem once
  failures are captured to Redis at the source.
- **No alerting on business anomalies** (lead volume dips, quote rates) —
  that's command-center territory, different project.

---

## 5. Build sequence & LOE

| # | What | Where | LOE | Catches |
|---|---|---|---|---|
| 1 | Watchdog: pipe freshness + health reachability + direct SMS + dedup/recovery state | `tools/src/watchdog/` + launchd | ~1 session | Tonight's entire incident class, in ≤15 min |
| 2 | Watchdog: cron cadence + launchd heartbeats (one-line SETs in each runner) | same + 4 runners | ~½ session | Dead crons, dead launchd jobs |
| 3 | Ack-fast/process-after for quo webhook (then PD) | `apps/middleware` [SACROSANCT — tests] | ~1 session each | Slow-path delivery failures ever recurring |
| 4 | Local-runner error capture → `health:errors` | `tools/` | ~¼ session | Crash-looping local automation |
| 5 | Triage "System health" section (P2/P3 rollup + overnight queue) | triage collector | ~½ session | Morning visibility without texts |
| 6 | Diagnostic-agent wrap (Walk) | `apps/agent` | later | Better texts, not more texts |

Items 1–2 are one evening and would have turned tonight's hour-long silent
outage into a 15-minute text with the fix in hand. Item 3 makes the recurrence
structurally impossible. 4–5 are mop-up. 6 is the existing long-term vision.

---

## 6. Acceptance test (how we know it works)

After items 1–3 ship, each of these injected failures must produce exactly
one P1 text within 15 min, one recovery text, and nothing else:

1. Disable the Quo webhook in the dashboard for 20 min (replay of tonight).
2. Point watchdog at a wrong health URL (simulated Vercel outage).
3. `launchctl unload` message-drafts for 90 min.
4. Delete the QB refresh token in a staging Redis key (qb-reconcile failure
   path → health:errors → SMS; verifies the exception pipeline end-to-end).

And the week after shipping must produce **zero** P1 texts that Matt reads
and shrugs at. A shrug = a threshold bug to fix immediately.
