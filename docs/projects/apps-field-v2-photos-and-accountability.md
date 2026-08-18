# apps/field v2 — Photos on Calendar + Time-Gating + Accountability

**Status:** Decisions locked 2026-06-04 — ready for build sequencing
**Created:** 2026-06-04
**Amends:** `docs/projects/apps-field.md` (v2 section: photo storage architecture, build phases)
**Trigger:** 2026-06-04 Mike conversation surfaced the need to (a) actually push photos back to Google Calendar (not just deep-link), (b) time-gate the check-in flow, (c) hold Mike accountable for owed photos.

---

## Locked decisions (2026-06-04)

1. **Photos upload to Mike's Drive** (his OAuth account), not Matt's shared account. Existing `audit-mike-photos.ts` heuristic stays valid; manual + field-app uploads unify under one Drive-ownership signal.
2. **Service-type classifier reuses `@aac/quoting/classifyScope`.** No new signals added — AAC does crack injection and concrete resurfacing, full stop. Not adding sump / waterproofing / encapsulation / gutters because AAC doesn't do that work.
3. **Late completion is tracked.** `CompletionRecord` gains `loggedLateBy: number` (days late).
4. **Owed view: two tabs.** Recent (last 14 days) for the steady-state banner; "Catch up: all of 2026" for short-term backfill.
5. **Cancellation reason is required.** Free-text input on the "Mark as cancelled / not done" action — no skipping.
6. **Banner persists until count = 0.** Not dismissible. The accountability signal is the point.
7. **New `@aac/accountability` package** for the shared owed-jobs query (lifted from `audit-mike-photos.ts`).

---

## What's changing from the existing spec

`apps-field.md:133` documented v2 as **"calendar event description gets a deep-link to the field-app gallery, photos stay in Blob, never written to Drive."** Matt wants the calendar event itself to surface the photos as attachments. That's a meaningful direction change. Documenting here so we don't drift without a paper trail.

---

## Architectural decision: whose Drive?

**Decision: Mike's Drive (uploaded by his OAuth account).** Reversal from my first pass — driven by what's already in the codebase.

### Why Mike's Drive is the right call

The script `tools/src/scratch/audit-mike-photos.ts` already implements the exact heuristic Matt is referring to: pull every "real job" from the calendar, look at each attachment's Drive owner, flag the job as "waiting on Mike" when no attachment is owned by him. That script is the canonical accountability source.

That logic:
- Filters events: `colorId === '10'` (green job), excludes titles containing `callback|lunch|dinner|meeting|estimate-only|consultation-only`, requires duration ≥ 120 minutes
- Checks `mikeEmails = ['mike@attackacrack.com', 'harrringtonm@gmail.com']` against each attachment's Drive `owners[].emailAddress`
- Job is "owed" when no Drive owner matches either of Mike's emails

**If we upload to Mike's Drive, all the existing logic keeps working unchanged.** Manual attachments Mike already did + field-app future uploads both produce the same signal (Mike-owned Drive file on the event). One unified accountability track.

If we'd gone with Matt's Drive, we'd have had to rewrite `audit-mike-photos.ts`, the `job-followups` cron's "real job" filter, and any cron that uses the same heuristic. Not worth it.

### What this means in practice

| Aspect | Implication |
|---|---|
| File ownership | Mike's account owns every photo he uploads |
| Cross-calendar attach | Mike's OAuth already has `calendar.events` scope → can PATCH Matt's calendar (Matt has shared the calendar with Mike at "Make changes to events" already, since Mike has been doing this manually) |
| Sharing prompts | Drive API exposes `permissions.create({role: 'reader', type: 'user', emailAddress: 'matt@attackacrack.com', sendNotificationEmail: false})` — call this silently right after upload so Matt has access without any UI prompt |
| Mike's Drive quota | Counts toward his Google One. Photos at \~1-2MB compressed; even 1000/year is 1-2 GB. Acceptable. |
| If Mike's account ever closed | Source-of-truth stays in Vercel Blob (we own). Drive copies are denormalized for calendar visibility — recoverable. |
| OAuth scopes for Mike | Keep `drive.file` + `calendar.events`. No simplification on his consent screen, but small cost. |

### Negative implications Matt asked about — direct answers

- **"What if it was just uploaded by him?"** → That's now the recommendation. No negatives that outweigh the reuse savings.
- **"Do we need to rewrite the other scripts?"** → No. `audit-mike-photos.ts` and any cron using the same heuristic continue to work unchanged.
- **The share-permission prompt Matt mentioned** → Programmatic: silenced via `drive.permissions.create({sendNotificationEmail: false})`. Mike never sees the prompt; Matt never gets a notification email; access is granted in the background.

---

## The pipeline

```
Mike taps "Take photo"
   │
   ▼
Browser uploads → Vercel Blob          [source of truth, kept forever]
   │
   ▼
Server action records Blob URL in CompletionRecord (Redis)
   │
   ▼
Server-side, using Mike's OAuth tokens:
   1. Fetch the Blob bytes server-side
   2. Resolve SEO-friendly filename (see below)
   3. Upload to Mike's Drive
   4. Grant Matt read access (silent, no email)
   5. PATCH Matt's Calendar event → add Drive file to event.attachments
   │
   ▼
Calendar event shows the photo as an attachment, owned by Mike,
indistinguishable from photos he manually attached before the field app
```

**Source of truth: Vercel Blob.** Drive + Calendar are denormalized. If Drive push fails, Blob is intact and we retry.

**Sync vs async:** async. Fire-and-forget after the form action returns so Mike's UI doesn't wait on Drive latency. The CompletionRecord tracks `driveFileId | null`, `driveUploadAttemptedAt | null`, `driveUploadError | null`. A Vercel cron sweeps every \~15 min for stuck records and retries.

**Mixing-prevention** (original v2 concern): tech-uploaded photos must remain visually distinguishable from Matt's pre-attached context photos. With Mike-owned uploads, the existing filter in `apps/field/app/events/[id]/page.tsx:97-106` works unchanged — Matt's pre-attached photos are owned by Matt, Mike's tech uploads are owned by Mike, the page already filters by `techEmails.has(owner)`.

---

## Time-gating the check-in flow

Four event-time buckets, four behaviors:

| Bucket | Definition | Check-in section | Photos section |
|---|---|---|---|
| **Future** | event.start > end-of-today (America/New_York) | Hidden entirely | Read-only — shows any context photos Matt pre-attached, no upload UI |
| **Today** | event.start within today | Normal full flow (check-in → before → after → complete) | Full upload + delete UI |
| **Past, not completed** | event.start < today AND no `completedAt` | Shows a **"Log late completion"** button that records `completedAt = now` and `loggedLateBy = floor((now - event.start) / 1day)` (days late). | Full upload + delete UI |
| **Past, completed** | event.start < today AND `completedAt` exists | Hidden | Add more / delete with per-photo confirm; never re-check-in |

Late-completion is a TRACKED SIGNAL, not just an override:
- `CompletionRecord` gains `loggedLateBy?: number` (days)
- Accountability view surfaces "X jobs logged late in last 30 days"
- Eventually this becomes a Mike performance metric — proportion of jobs logged same-day vs. late

Edge case: a job today at 9am still counts as Today even at 8pm. "Today" recomputes per request from `America/New_York`.

Cancellation escape hatch (separate from late completion): button on the event detail page, "Mark this as cancelled / not done." Records `cancelledAt`, `cancelledByEmail`, `cancellationReason` (optional). Removes the event from the owed list without forcing a fake completion.

Implementation: `app/events/[id]/page.tsx` computes the bucket from `evt.start` and passes to `CompletionChecklist`, which renders the right section. Server actions re-check the bucket (don't trust client).

---

## Photo deletion semantics

Universal:
- **Per-photo confirmation modal** (no bulk)
- **Delete cascade:** Blob → Drive → Calendar event attachments. Each step swallows downstream failures and continues
- **Adding more photos is always allowed** (except for future events)

Phase-specific:
- **Before completion:** deleting the required before/after photo reverts the phase backward (e.g. `before_photo_taken` → `checked_in`). Re-prompt to retake.
- **After completion:** all photos deletable. Don't downgrade phase. We assume Mike is correcting a wrong upload, not undoing the job.

---

## Accountability view

### Definition of "owes photos" (lifted directly from `audit-mike-photos.ts`)

The check is *Drive-attachment ownership on the calendar event*, not Redis CompletionRecord. This is the existing canonical signal and we should align to it:

> A job is **owed** when, for an event matching the "real job" filter, NO attachment on the calendar event is owned by `mike@attackacrack.com` OR `harrringtonm@gmail.com`.

Real-job filter (matches existing audit + `job-followups` cron):
- `colorId === '10'`
- Event title does NOT contain (case-insensitive): `callback`, `lunch`, `dinner`, `meeting`, `estimate-only`, `consultation-only`
- Duration ≥ 120 minutes

This works regardless of whether photos came from the field app or Mike's manual workflow. **Single source of truth: Drive ownership on the calendar event.**

### Two time windows

**Long-run (steady state): last 14 days.** Banner threshold on home: show only when count > 0.

**Short-run catch-up: every 2026 event.** Matt explicitly wants Mike to see EVERY 2026 job he owes photos on, not just the last 14 days. Two-tab UX on `/owed`:
- **Recent (last 14 days)** — default view, banner-linked
- **Catch up (all of 2026)** — secondary view, longer list, no banner

Eventually (once Mike is caught up) the "Catch up" tab can be removed or hidden behind a "Show older" toggle. For now, both tabs ship in v1.

### Implementation: shared module

Lift the audit script's core into a shared module so the field app, the cron, and the script all share logic:

```
packages/accountability/   (new package, or fold into @aac/scheduling)
  src/
    owed-photos.ts   — exports listOwedJobs({calendarId, since, mikeEmails, calendarClient, driveClient}) → OwedJob[]
    job-filter.ts    — exports the canonical "real job" filter
```

Then:
- `apps/field/app/owed/page.tsx` calls `listOwedJobs({since: 14 days ago})` or `({since: '2026-01-01'})` depending on tab
- The existing audit script imports the same function
- Any future cron also imports the same function

Cache strategy: write the owed-jobs list to Redis under `keys.mikeOwedPhotos` with a 15-min TTL. The Drive lookups are the expensive part (\~2 sec per attachment). With caching, the /owed page renders fast.

### UI surfaces

- **Top-of-app banner** on `app/page.tsx` (the today view) when 14-day count > 0. Text: "You owe photos on {N} past job(s). Tap to review."
- **`app/owed/page.tsx`** — the two-tab list view. Each row: customer name, date, link to event detail. Tap → event detail page → upload photos there.
- **No notifications to Matt.** Per [[feedback_no_proactive_notifications]].

---

## Filename schema (SEO)

```
{town}-{servicetype}-{date}-{label}[-{seq}].jpg
```

Examples:
- `quincy-crack-injection-2026-06-04-before.jpg`
- `quincy-concrete-resurfacing-2026-06-04-after.jpg`
- `quincy-crack-injection-2026-06-04-extra-2.jpg`

### Where each piece comes from

| Piece | Source |
|---|---|
| `town` | Parse from `evt.location` (e.g. `, Quincy MA` → `quincy`); fallback to PD person `city` |
| `servicetype` | **`@aac/quoting/classifyScope`** against the linked QB Estimate's line items. Returns `crack_injection` / `concrete_resurfacing` / `mixed` / `other`. Map: `other` → `foundation-repair` (catch-all). Fallback when no linked estimate exists: keyword heuristic on `evt.summary` (same set: `crack` → `crack-injection`, `resurfac` → `concrete-resurfacing`, else `foundation-repair`). |
| `date` | `evt.start` formatted YYYY-MM-DD in America/New_York |
| `label` | `before` / `after` / `extra` from form context |
| `seq` | Count of existing photos with the same label, +1. Only added for `seq > 1`. |

**Service type uses the real classifier.** `@aac/quoting/classifyScope` is already in the codebase ([[project_aac_service_categories]] is its source-of-truth doc) — no new keyword heuristic needed. The signals it detects are extensive:

- **Crack signals:** urethane, inject, membrane, carbon fiber
- **Concrete signals:** resurfac, overlay, spall, driveway, stairway, garage, walkway, patio, step, stair, floor crack, repoint, fieldstone, masonry, brick repair, skim coat, wall surface prep, floor epoxy, floor only

If Matt wants to add `sump` / `waterproof` / `encapsulation` / `gutter` to the recognized signals, those should be added to `classify-scope.ts` (one location, used by quoting + filenames + reporting), not as a one-off heuristic in the field app.

### Where the name is applied

- **Vercel Blob path:** `field/{eventId}/{seo-name}.jpg` — keeps eventId-based folder structure for app routing
- **Google Drive file title:** the SEO name (no folder prefix). Shows in Calendar attachment thumbnail tooltip and any future website pull
- **Calendar attachment label:** Drive uses the Drive file title automatically

### Customer-identifying info: deliberately excluded

Towns and service types are queryable SEO content. Customer names are not + are a privacy concern if photos ever surface on the public website.

---

## Updated open decisions for Matt

Most prior questions resolved themselves now that we landed on Mike's Drive. Remaining:

1. **Confirm: Mike's Drive (reversal from my first plan).** Lets `audit-mike-photos.ts` keep working unchanged, aligns with manual workflow.
2. **`classifyScope` additions:** want me to add `sump` / `waterproof` / `encapsulation` / `gutter` as recognized signals? They'd produce new category slugs (`waterproofing`, `sump-pump`, `encapsulation`, etc.) — useful for both quote drafting AND filenames.
3. **Late-completion tracking confirmed** — yes per Matt's reply.
4. **Owed list scope confirmed** — 14-day banner + "Catch up: all of 2026" tab.
5. **Cancellation reason required or optional?** — recommendation: optional. Required text creates friction.
6. **Banner copy and frequency** — show only when count > 0; text: "You owe photos on N past job(s)." Should it dismiss on tap or persist until count reaches 0? Recommendation: persist (it's the accountability signal).

---

## Build phasing

| Phase | Scope | Risk | Est. effort |
|---|---|---|---|
| **A** | Time-gating buckets in UI + server actions. Late-completion tracking field. Cancellation escape hatch. | Low | ~2.5h |
| **B** | Photo deletion with per-photo confirm; cascade to Blob; phase revert for required photos before completion | Medium | ~3h |
| **C** | Drive upload (Mike's account) + Calendar PATCH + silent Matt-read permission grant. SEO filename via `classifyScope`. Async retry cron. | High — new Drive API surface, retry semantics, OAuth token refresh | ~6h |
| **D** | Delete cascade extended to Drive + Calendar (extends B) | Medium | ~1.5h |
| **E** | Accountability view: lift `audit-mike-photos.ts` into shared `packages/accountability` module, /owed page with two tabs, home banner. Redis cache + 15-min refresh cron. | Medium | ~5h |

Build order: **A → B → C → E → D**. A first because it's pure UI + minimally invasive. B can ship before the Drive push because deletion of Blob is meaningful even without Drive cascading. C is the highest-value (and longest) phase. E sits on top of C's Drive infrastructure being live.

**Don't build B until A is in production** — same UI surface, regression risk.

**One package question to settle first:** new `packages/accountability` vs fold into `@aac/scheduling` vs fold into `@aac/quoting`? Recommendation: NEW package (`@aac/accountability`) — it's a clear separable concern (owed-work tracking) and folding it into scheduling or quoting muddies their purpose.

---

## What this does NOT cover

- **Review-ask button** — spec in `analysis/02-strategy/mike-call-field-app-test-plan-2026-06-04.md`.
- **Photos pulled to public website for SEO** — `apps/website` initiative downstream of C.
- **Multi-tech support** — single Mike for now; tech #2 adds per-tech filter to owed view; calendar-push pattern is unchanged.

---

## Related

- Existing spec: `docs/projects/apps-field.md`
- Original v2 deep-link decision (now superseded by this plan): `apps-field.md:133-143`
- Canonical accountability heuristic: `tools/src/scratch/audit-mike-photos.ts`
- Service classifier: `packages/quoting/src/classify-scope.ts`
- Today's Mike conversation: `analysis/02-strategy/mike-raise-conversation-2026-06-04.md`
- Field-app live-test plan from today: `analysis/02-strategy/mike-call-field-app-test-plan-2026-06-04.md`
