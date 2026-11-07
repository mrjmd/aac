/** Where an item lives in the command center. */
export type Area = 'sales' | 'jobs' | 'money' | 'marketing' | 'admin' | 'system' | 'inbox';

/** "Needs you" vs "Automation did this, confirm" (README §4.1, two lanes). */
export type Lane = 'needs-you' | 'confirm';

export type Severity = 'red' | 'yellow' | 'info';

/** What a detector emits. Recomputed every run; identity comes from `key`. */
export interface ItemCandidate {
  /** Stable identity: detector + entity ids, e.g. "d5:3766". */
  key: string;
  /** Detector id, e.g. "D5". Mute rules match on this. */
  detector: string;
  area: Area;
  lane: Lane;
  severity: Severity;
  title: string;
  customer?: string;
  phone?: string;
  amount?: number;
  detail?: string;
  action?: string;
  /** Why this item exists (shown with the item). */
  evidence?: string;
  link?: string;
  /** Hash of the facts that matter. A change reopens done/dismissed items. */
  fingerprint: string;
  /** Money and legal items ask for a confirm before dismiss or mute. */
  sensitive?: 'money' | 'legal';
  /** A hard time: a promise ("I'll call at 2pm") or a customer ask with a time. ISO. Ranks first. */
  dueAt?: string;
  /** When the event this item is about starts (ISO): a stub to review, a hold to resolve. This week pins it to that day; ranking ignores it. */
  dueOn?: string;
  /** A customer has been waiting on Matt since this time (their last inbound). ISO. */
  waitingSince?: string;
  /** Someone selling to Matt. Sinks to the bottom and collapses. */
  solicitation?: boolean;
  /** Who it's about, for one-person-one-item grouping. `cluster` is the triage identity cluster (per run). */
  who?: { phones?: string[]; emails?: string[]; cluster?: string };
}

export type ItemStatus = 'open' | 'done' | 'snoozed' | 'dismissed';

export type DismissReason = 'not-real' | 'already-handled' | 'not-mine' | 'wrong-match' | 'other';

/** What Matt did to an item. Persisted by key. */
export interface ItemState {
  key: string;
  status: ItemStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Matt has seen and placed it (moves it out of the "new" band). */
  placedAt?: string;
  /** When the last verb was applied, and the fingerprint at that moment. */
  actedAt?: string;
  actedFingerprint?: string;
  snoozeUntil?: string;
  dismissReason?: DismissReason;
  dismissNote?: string;
  /** Set when new evidence reopened a done/dismissed/snoozed item. */
  reopenedAt?: string;
  /** ISO date (YYYY-MM-DD, America/New_York) the item is on Today from. */
  pinnedFor?: string;
  /** First day it sat on Today (rollover pressure counts from here). */
  pinnedSince?: string;
  /** Matt's order on Today; lower is higher. */
  rank?: number;
  /** Title/customer as of the last verb, for lists of items whose detector stopped emitting them. */
  snapshot?: { title: string; customer?: string; detector: string };
}

/** "This kind is noise": detector + optional case-insensitive match on customer/title/phone. */
export interface MuteRule {
  id: string;
  detector: string;
  match?: string;
  note?: string;
  createdAt: string;
}

export type Band = 'today' | 'new' | 'list';

export interface Item extends ItemCandidate {
  state: ItemState;
  band: Band;
  /** Days on Today since first pinned; >= 3 means do it, schedule it, or let it go. */
  rolloverDays?: number;
  /** Ranking score (higher first) and the plain reasons behind it (rank.ts). */
  score: number;
  why: string[];
  /** On Today because the ranking put it there, not because Matt pinned it. */
  suggested?: boolean;
  /** The same person's other items, folded under this one (group.ts). */
  related?: Item[];
}

export type HiddenReason = 'done' | 'snoozed' | 'dismissed' | 'muted';

export interface ReconcileResult {
  /** Today (suggested by score, then Matt's rank order), then new, then list (both by score). One item per person. */
  items: Item[];
  hidden: Array<{ key: string; reason: HiddenReason; candidate: ItemCandidate }>;
  /** Every state after this run (new ones created, reopened ones updated). Persist all. */
  states: Record<string, ItemState>;
}
