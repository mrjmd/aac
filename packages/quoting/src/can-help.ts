/**
 * can-help — the owner's standing rules (what AAC declines, time-bound
 * policies like the resurfacing pause) and the referral list (who gets the
 * work we don't do). Both live in Redis so the command center can edit them
 * and every drafter reads the same list. Plan:
 * docs/plans/can-help-and-referrals.md; evidence:
 * analysis/02-strategy/decline-patterns-2026-11.md.
 */
import { keys } from '@aac/shared-utils/redis';

export interface Referral {
  id: string;
  /** Person or company as Matt names them to customers ("Henry at Best Bulkheads"). */
  name: string;
  phone?: string;
  /** What kinds of work we send them, in plain words. */
  sends: string;
  note?: string;
}

/** decline = we don't do it; case-by-case = Matt decides each one (never an automatic decline); policy = time-bound. */
export type StandingRuleKind = 'decline' | 'case-by-case' | 'policy';

export interface StandingRule {
  id: string;
  kind: StandingRuleKind;
  /** Chip label on the Referrals page ("Leaking cinder block"). */
  short?: string;
  /** The rule as Matt would say it. */
  text: string;
  /** Referral ids that fit this rule, in preference order. */
  referralIds?: string[];
  since: string; // YYYY-MM-DD
  /** Hard end date (YYYY-MM-DD); the rule stops applying after it. */
  until?: string;
  /** Open-ended end condition ("when tech #2 starts"); shown, never evaluated. */
  untilWhen?: string;
  /** Date to re-ask Matt whether the rule still holds. */
  reviewBy?: string;
  /** Switched off in the command center; kept for switching back on. */
  paused?: boolean;
}

/** Active on `today` (YYYY-MM-DD): not paused, started, and not past a hard end date. */
export function isRuleActive(rule: StandingRule, today: string): boolean {
  return !rule.paused && rule.since <= today && (!rule.until || today <= rule.until);
}

/** Prompt block both drafters inject: active rules with their referrals, then the referral list. */
export function buildCanHelpBlock(args: { rules: StandingRule[]; referrals: Referral[]; today: string }): string {
  const byId = new Map(args.referrals.map((r) => [r.id, r]));
  const who = (r: Referral) => `${r.name}${r.phone ? ` ${r.phone}` : ''}`;
  const line = (rule: StandingRule) => {
    const refs = (rule.referralIds ?? []).map((id) => byId.get(id)).filter((r): r is Referral => !!r);
    const until = rule.until ? ` (until ${rule.until})` : rule.untilWhen ? ` (until ${rule.untilWhen})` : '';
    return `- ${rule.text}${until}${refs.length ? ` → refer: ${refs.map(who).join('; ')}` : ''}`;
  };
  const active = args.rules.filter((r) => isRuleActive(r, args.today));
  const declines = active.filter((r) => r.kind === 'decline');
  const caseByCase = active.filter((r) => r.kind === 'case-by-case');
  const policies = active.filter((r) => r.kind === 'policy');
  return [
    `WE CAN'T HELP WITH (owner's standing rules; decline kindly and point them to the referral when one fits):`,
    ...declines.map(line),
    ...(caseByCase.length
      ? ['', 'CASE BY CASE (Matt decides each one: never decline these yourself; flag them for him; the referral is for if he passes):', ...caseByCase.map(line)]
      : []),
    ...(policies.length ? ['', 'CURRENT OWNER POLICIES:', ...policies.map(line)] : []),
    '',
    'REFERRALS (who we send other work to):',
    ...args.referrals.map((r) => `- ${who(r)}: ${r.sends}`),
  ].join('\n');
}

/** A new record id from its name, unique among `taken` ("Air Guardian" → "air-guardian", then "air-guardian-2"). */
export function canHelpId(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  const have = new Set(taken);
  let id = base;
  for (let n = 2; have.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** End a rule now: its hard end becomes yesterday, so it is inactive from `today` on. */
export function endRule(rule: StandingRule, today: string): StandingRule {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { ...rule, until: d.toISOString().slice(0, 10) };
}

export interface CanHelpRedis {
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
}

/** Redis persistence: one hash field per referral / rule. */
export class CanHelpStore {
  constructor(private redis: CanHelpRedis) {}

  async referrals(): Promise<Referral[]> {
    const all = (await this.redis.hgetall<Record<string, Referral>>(keys.canHelpReferrals)) ?? {};
    return Object.values(all).sort((a, b) => a.name.localeCompare(b.name));
  }

  async rules(): Promise<StandingRule[]> {
    const all = (await this.redis.hgetall<Record<string, StandingRule>>(keys.canHelpRules)) ?? {};
    return Object.values(all).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  async putReferral(r: Referral): Promise<void> {
    await this.redis.hset(keys.canHelpReferrals, { [r.id]: r });
  }

  async putRule(r: StandingRule): Promise<void> {
    await this.redis.hset(keys.canHelpRules, { [r.id]: r });
  }

  /** Removes the referral and unlinks it from every rule that pointed to it. */
  async removeReferral(id: string): Promise<void> {
    const linked = (await this.rules()).filter((r) => r.referralIds?.includes(id));
    for (const r of linked) await this.putRule({ ...r, referralIds: r.referralIds!.filter((x) => x !== id) });
    await this.redis.hdel(keys.canHelpReferrals, id);
  }

  async removeRule(id: string): Promise<void> {
    await this.redis.hdel(keys.canHelpRules, id);
  }

  /** The prompt block for `today`, read fresh from Redis. */
  async block(today: string): Promise<string> {
    const [rules, referrals] = await Promise.all([this.rules(), this.referrals()]);
    return buildCanHelpBlock({ rules, referrals, today });
  }
}
