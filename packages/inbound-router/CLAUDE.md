# @aac/inbound-router — one read per settled customer burst

Design and rollout: `docs/plans/inbound-router.md`. **Off by default; shadow on
demand; routes go live one at a time (phase 4).** Nothing here texts anyone; a
live route posts the same draft notes the old path did.

- The Quo webhook arms `inbound:due` (settle rule in
  `@aac/shared-utils/inbound-settle`: last event + 2 min, capped at first + 10 min).
- `tick.ts` (`runInboundTick`, worker `/api/inbound-tick`): per settled phone,
  lock → load thread → skip/wait when the customer said nothing yet (a call that
  rang out waits up to the voicemail grace) → `readInbound` → `decide` → LPUSH
  `inbound:shadow` with what the old paths had done (`legacy`) and, for live
  routes, what the drafters did (`acted`). A drafter's retry-later (no Quo
  contact yet) re-arms the phone; the retry re-decides from the saved read.
- `read.ts`: one Gemini call over the thread, voicemails, can't-help rules (with
  ids) and new photos. Saved at `inbound:read:{phone}`; an unchanged fingerprint
  is a no-op; photo descriptions are cached by `{messageId}:{index}`.
- `decide.ts`: pure route choice. Every rule has a test.
- `act.ts`: live routes (Redis `inbound-router:live`, comma list). `intake`:
  intake, CT routing and a decline before Matt has replied go to
  message-drafts `processRoutedIntake` (one draft-only call from this read).
  The worker then clears the old intake queue and its sweep calls
  `sweepInbound` (`sweep.ts`: re-arms phones whose newest customer message is
  newer than the saved read) instead of `sweepIntake`. `quote` and `referral`
  are not wired yet.
- Mode: Redis `inbound-router:mode`. Unset/`off` clears settled bursts unread
  (no Gemini); `shadow` reads and logs. Tuning is done by replaying past leads
  (`tools/src/scratch`), not by running shadow in production.
- No `process.env` here; the worker builds the clients.
