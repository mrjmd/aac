# @aac/items — the command center's item system

Every actionable thing (triage findings, recon flags, deposit gaps, stale
quotes, deadlines, to-dos) becomes one **Item** with stable identity and
owner-controlled state. Spec: `docs/plans/command-center/README.md` §4.

- `types.ts` — ItemCandidate (what a detector emits: stable `key` +
  evidence `fingerprint`), ItemState (what Matt did to it), MuteRule.
- `reconcile.ts` — pure: candidates + states + mutes + now → what shows,
  in which band (today / new / list), and what's hidden and why.
- `verbs.ts` — pure state transitions: done, snooze, dismiss, restore,
  pin to a day, place, reorder.
- `from-triage.ts` — adapter from today's triage `findings.json`.
- `store.ts` — Redis persistence (keys from `@aac/shared-utils/redis`).

## Rules

- **Matt's order is sacred.** Nothing here assigns a rank on its own; new
  and reopened items land in the `new` band for Matt to place.
- **The fingerprint decides "material change".** Done / dismissed items
  come back only when the fingerprint changes; snoozed ones also come back
  when the time passes. Never put ages or "3d ago" text in a fingerprint.
- **Money and legal items need `confirmed: true` to dismiss or mute.**
- Keep `reconcile` and `verbs` pure (no I/O); tests cover them.
