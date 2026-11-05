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
- `rank.ts` — pure: score + reasons, Today suggestions, logged features.
- `group.ts` — pure: one person = one item.
- `from-triage.ts` — adapter from today's triage `findings.json`.
- `store.ts` — Redis persistence (keys from `@aac/shared-utils/redis`).
- `people.ts` — People (Mike, Ed): agenda topics, past conversations,
  tagged item keys, facts; pure ops + `PeopleStore`. Client-safe, so the
  app imports it from `@aac/items/people` (the index pulls `node:crypto`).

## Rules

- **The ranking proposes, Matt's drag decides** (Matt, 2026-11-05; was
  "nothing assigns a rank"). `rank.ts` scores every item: deadlines and
  promises, then how recently a customer has been waiting, then dollars;
  solicitations sink. The top few are *suggested* onto Today above Matt's
  own order. A drag pins them and from then on his rank wins. An item he
  placed is not re-suggested until the customer writes again.
- **Every drag and verb is logged** with `rankFeatures` (`ItemStore.logRank`,
  `keys.itemRankLog`) so the weights can be fit to his corrections.
- **One person = one item** (`group.ts`): items sharing a phone, email,
  triage identity cluster, or full name fold under the strongest one.
- **The fingerprint decides "material change".** Done / dismissed items
  come back only when the fingerprint changes; snoozed ones also come back
  when the time passes. Never put ages or "3d ago" text in a fingerprint.
- **Money and legal items need `confirmed: true` to dismiss or mute.**
- Keep `reconcile` and `verbs` pure (no I/O); tests cover them.
