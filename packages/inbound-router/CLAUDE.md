# @aac/inbound-router — one read per settled customer burst

Design and rollout: `docs/plans/inbound-router.md`. **Phase 3: shadow only.**
Nothing here posts a note, writes drafter state, or texts anyone.

- The Quo webhook arms `inbound:due` (settle rule in
  `@aac/shared-utils/inbound-settle`: last event + 2 min, capped at first + 10 min).
- `tick.ts` (`runInboundTick`, worker `/api/inbound-tick`): per settled phone,
  lock → load thread → skip/wait when the customer said nothing yet (a call that
  rang out waits up to the voicemail grace) → `readInbound` → `decide` → LPUSH
  `inbound:shadow` with what the old paths had done (`legacy`).
- `read.ts`: one Gemini call over the thread, voicemails, can't-help rules (with
  ids) and new photos. Saved at `inbound:read:{phone}`; an unchanged fingerprint
  is a no-op; photo descriptions are cached by `{messageId}:{index}`.
- `decide.ts`: pure route choice. Every rule has a test.
- Kill switch: Redis `inbound-router:mode` = `off`.
- No `process.env` here; the worker builds the clients.
