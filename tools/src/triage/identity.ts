/**
 * Triage identity cross-reference — ONE answer to "who is this customer, and
 * are they already booked?" shared by every detector in analyze.ts.
 *
 * Why (2026-11-03): the dashboard kept surfacing customers who were already
 * on the calendar because each detector joined on its own fuzzy key (thread
 * phone, email display name, QBO customer name, event summary) and none of
 * them saw the others. A customer is routinely known by several handles:
 *   - Tom Dacey (QBO 1534, company "Champion Builders") + Champion Builders
 *     (QBO 33, same phone) + Sarah Dacey (QBO 2311, different phone, email
 *     sarah@championbuilders.com, same 138 Elm St Unit 35 address). Their
 *     booking is "STUB — Sarah", found only via the stub's directive phone.
 *   - Artie Downey (QBO) = "Arthur Downey <adowneyjr@me.com>" (email; the
 *     QBO address has a typo) — joined by the "Quote 1580" subject, the
 *     133 Bayside Road address, and first-name-prefix + surname.
 *
 * Model: union-find over hard identity keys — `qbo:{id}`, `phone:{E.164}`,
 * `email:{addr}`, `name:{company/display name}`. Keys shared by 3+ QBO
 * customers are hubs (placeholder phones, a realtor's email on many
 * clients) and never merge anything. Addresses (`{num}|{street}|{unit}`)
 * are attach-only: an event or subject at an address reaches every
 * customer on file there, but an address never fuses two customers (Ed
 * Crowell's QBO record carries Tom Dacey's home address; buyer + seller
 * share a property). Calendar events and threads are observers too — they
 * attach to clusters but never merge two, so one sloppy event can't fuse
 * two customers.
 *
 * The booked-customer policy (applyBookedSuppression) only touches findings
 * about getting a customer scheduled/closed. Cash findings (D1-D3), stub
 * review (D10), incomplete events (D11) and booked-gap backstops (D4/D14)
 * are never suppressed here.
 */

import { nameTokens, tokensAlike } from '@aac/customers';
import { streetKey } from '@aac/shared-utils/address';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import type { CustomerSnapshot, EmailThreadSnapshot, ThreadSnapshot } from './collect.ts';
import { EVENT_CLASS_COLOR_IDS as COLORS } from '@aac/shared-utils/calendar';

const DAY = 86_400_000;

// Name + address matching lives in @aac/customers (moved 2026-11-03) so
// the command center Customer page and scheduling share one definition.
export { nameTokens, tokensAlike, streetKey };

/** Strip calendar workflow prefixes so "STUB — Artie Downey" reads as a name. */
function personFromSummary(summary: string): string {
  return summary
    .replace(/^\s*(?:STUB|HOLD)\b[\s—:-]*/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim();
}

// ── inputs ───────────────────────────────────────────────────────────

export interface IdEvent {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  start: string;
  colorId?: string;
  created?: string;
}

interface IdAddr {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
}

export interface IdTxn {
  DocNumber?: string;
  CustomerRef?: { value?: string; name?: string };
  BillAddr?: IdAddr;
  ShipAddr?: IdAddr;
}

export interface IdentityInputs {
  customers: CustomerSnapshot[];
  estimates: IdTxn[];
  invoices: IdTxn[];
  threads: ThreadSnapshot[];
  emails: EmailThreadSnapshot[];
  calendar: IdEvent[];
  /** Scheduling directives (pending + review) — stub/hold descriptions cite their ids. */
  directives: Array<Record<string, unknown>>;
  /** Our own lines (business, agent) — never identity keys. */
  ownPhones: string[];
  now: number;
}

/** What a finding knows about who it is about. Any subset works. */
export interface Subject {
  phones?: string[];
  emails?: string[];
  qboId?: string;
  names?: string[];
  emailThreadId?: string;
  address?: string;
}

export interface BookedJob {
  eventId: string;
  summary: string;
  start: string;
  /** Event creation time ("booked at"); 0 when the API didn't return it. */
  createdMs: number;
}

// ── union-find ───────────────────────────────────────────────────────

class Dsu {
  private parent = new Map<string, string>();
  add(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  has(k: string): boolean {
    return this.parent.has(k);
  }
  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
  find(k: string): string {
    this.add(k);
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = k;
    while (c !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const addrLines = (a?: IdAddr): string[] =>
  a ? [a.Line1, a.Line2, a.Line3, a.Line4, a.Line5].filter((l): l is string => !!l) : [];
const normName = (s: string): string => nameTokens(s).join(' ');
const normPhone = (p: string): string | null => quickNormalizePhone(p);
const DOC_RE = /\b(?:quote|estimate|invoice)\s*(?:#|no\.?)?\s*(\d{3,6})\b/i;

// ── the index ────────────────────────────────────────────────────────

export class IdentityIndex {
  private dsu = new Dsu();
  private hubs = new Set<string>();
  private own = new Set<string>();
  private docToQbo = new Map<string, string>();
  /** Soft name lookup: clusters with a ≥2-token person/company name. */
  private people: Array<{ first: string; last: string; key: string }> = [];
  private emailThreadKey = new Map<string, string>();
  private bookedByRoot = new Map<string, BookedJob[]>();
  private activityByRoot = new Map<string, { in: number; out: number }>();
  /** addr key → QBO customer ids on file at that address (attach-only). */
  private addrOwners = new Map<string, Set<string>>();

  constructor(inp: IdentityInputs) {
    for (const p of inp.ownPhones) {
      const n = normPhone(p);
      if (n) this.own.add(n);
    }

    // 1. Hub detection — a key on 3+ distinct customers merges nothing.
    const owners = new Map<string, Set<string>>();
    const own = (key: string, qbo: string): void => {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(qbo);
    };
    const customerKeys = new Map<string, string[]>();
    const keysFor = (qbo: string): string[] => {
      if (!customerKeys.has(qbo)) customerKeys.set(qbo, []);
      return customerKeys.get(qbo)!;
    };
    const displayCount = new Map<string, number>();
    for (const c of inp.customers) {
      const n = normName(c.name);
      if (n) displayCount.set(n, (displayCount.get(n) ?? 0) + 1);
    }
    for (const c of inp.customers) {
      const ks = keysFor(c.id);
      for (const p of c.phones) {
        const n = normPhone(p);
        if (n && !this.own.has(n)) ks.push(`phone:${n}`);
      }
      for (const e of c.emails ?? []) ks.push(`email:${e.toLowerCase()}`);
      // Company/display names merge only when unambiguous (one customer
      // carries that display name) and are multi-token ("Sarah" is not an
      // identity; "Champion Builders" is).
      for (const raw of [c.name, c.companyName ?? '']) {
        const n = normName(raw);
        if (n.includes(' ') && (displayCount.get(n) ?? 0) <= 1) ks.push(`name:${n}`);
      }
      for (const line of c.addresses ?? []) this.addAddress(line, c.id);
    }
    for (const t of [...inp.estimates, ...inp.invoices]) {
      const qbo = t.CustomerRef?.value;
      if (!qbo) continue;
      if (t.DocNumber) this.docToQbo.set(t.DocNumber, qbo);
      for (const line of [...addrLines(t.BillAddr), ...addrLines(t.ShipAddr)]) this.addAddress(line, qbo);
    }
    for (const [qbo, ks] of customerKeys) for (const k of ks) own(k, qbo);
    for (const [k, set] of owners) if (set.size >= 3) this.hubs.add(k);

    // 2. Merge each customer with its non-hub keys.
    for (const [qbo, ks] of customerKeys) {
      const node = `qbo:${qbo}`;
      this.dsu.add(node);
      for (const k of ks) if (!this.hubs.has(k)) this.dsu.union(node, k);
    }
    for (const c of inp.customers) {
      for (const raw of [c.name, c.companyName ?? '']) {
        const t = nameTokens(raw);
        if (t.length >= 2) this.people.push({ first: t[0], last: t[t.length - 1], key: `qbo:${c.id}` });
      }
    }

    // 3. Email threads attach (never merge two customers): exact address,
    //    then "Quote 1580" in the subject, then a street address in the
    //    subject, then the sender's display name.
    for (const t of inp.emails) {
      const addrKey = `email:${t.counterpartyAddress.toLowerCase()}`;
      let target: string | null = this.dsu.has(addrKey) ? addrKey : null;
      if (!target) {
        const doc = DOC_RE.exec(t.subject)?.[1];
        const qbo = doc ? this.docToQbo.get(doc) : undefined;
        if (qbo) target = `qbo:${qbo}`;
      }
      if (!target) {
        const roots = this.rootsForAddress(t.subject, true);
        if (roots.length === 1) target = roots[0];
      }
      if (!target) {
        target = this.softName(t.counterparty.replace(/<[^>]*>/, ''));
      }
      if (target) {
        // Attach the address to that cluster unless it already belongs to a
        // different one (then leave both alone — no observer-driven merges).
        if (!this.dsu.has(addrKey)) this.dsu.union(target, addrKey);
        this.emailThreadKey.set(t.threadId, target);
      } else {
        this.dsu.add(addrKey);
        this.emailThreadKey.set(t.threadId, addrKey);
      }
    }

    // 4. Activity per cluster across every channel.
    const bump = (key: string, dir: 'in' | 'out', at: string): void => {
      const ms = new Date(at).getTime();
      if (!Number.isFinite(ms)) return;
      const root = this.dsu.find(key);
      const a = this.activityByRoot.get(root) ?? { in: 0, out: 0 };
      a[dir] = Math.max(a[dir], ms);
      this.activityByRoot.set(root, a);
    };
    for (const t of inp.threads) {
      const p = normPhone(t.phone);
      if (!p) continue;
      const key = `phone:${p}`;
      for (const m of t.messages) bump(key, m.direction === 'incoming' ? 'in' : 'out', m.at);
      for (const c of t.calls) {
        bump(key, c.direction === 'incoming' ? 'in' : 'out', c.at);
        // An answered inbound call is a two-way conversation — Matt talked
        // to them (Artie / Joffre were booked by phone).
        if (c.direction === 'incoming' && c.status === 'completed' && c.durationSec > 0) bump(key, 'out', c.at);
      }
    }
    for (const t of inp.emails) {
      const key = this.emailThreadKey.get(t.threadId)!;
      for (const m of t.messages) bump(key, m.direction === 'incoming' ? 'in' : 'out', m.at);
    }

    // 5. Booked jobs: green events today-or-later (STUBs included), linked
    //    by directive phone / hold phone, address, then name.
    const directivePhone = new Map<string, string>();
    for (const d of inp.directives) {
      const id = typeof d.id === 'string' ? d.id : '';
      const phone = typeof d.customerPhone === 'string' ? normPhone(d.customerPhone) : null;
      if (id && phone) directivePhone.set(id, phone);
    }
    for (const ev of inp.calendar) {
      if (ev.colorId !== COLORS.job) continue;
      if (new Date(ev.start).getTime() < inp.now - DAY) continue;
      const roots = new Set<string>();
      const desc = ev.description ?? '';
      const phones = new Set<string>();
      const cp = /Customer-Phone:\s*(\+?\d[\d\s().-]*)/.exec(desc)?.[1];
      if (cp) {
        const n = normPhone(cp);
        if (n) phones.add(n);
      }
      for (const m of desc.matchAll(/directive ([0-9a-f]{8}-[0-9a-f-]{27})/gi)) {
        const p = directivePhone.get(m[1]);
        if (p) phones.add(p);
      }
      for (const p of phones) if (!this.own.has(p)) roots.add(this.dsu.find(`phone:${p}`));
      for (const r of this.rootsForAddress(ev.location ?? '')) roots.add(r);
      const soft = this.softName(personFromSummary(ev.summary));
      if (soft) roots.add(this.dsu.find(soft));
      const job: BookedJob = {
        eventId: ev.id,
        summary: ev.summary,
        start: ev.start,
        createdMs: ev.created ? new Date(ev.created).getTime() : 0,
      };
      for (const r of roots) {
        const list = this.bookedByRoot.get(r) ?? [];
        list.push(job);
        this.bookedByRoot.set(r, list);
      }
    }
  }

  /** Unique cluster for a person/company name, or null when ambiguous. */
  private softName(raw: string): string | null {
    const exact = `name:${normName(raw)}`;
    if (exact.includes(' ') && this.dsu.has(exact) && !this.hubs.has(exact)) return exact;
    const t = nameTokens(raw);
    if (t.length < 2) return null;
    const first = t[0];
    const last = t[t.length - 1];
    const roots = new Set<string>();
    for (const p of this.people) {
      if (!tokensAlike(p.last, last)) continue;
      // Nicknames share a prefix: Artie/Arthur, Tom/Thomas, Ann/Anne.
      if (p.first.slice(0, 3) !== first.slice(0, 3) && !tokensAlike(p.first, first)) continue;
      roots.add(this.dsu.find(p.key));
    }
    return roots.size === 1 ? [...roots][0] : null;
  }

  private addAddress(line: string, qbo: string): void {
    const k = streetKey(line);
    if (!k) return;
    if (!this.addrOwners.has(k)) this.addrOwners.set(k, new Set());
    this.addrOwners.get(k)!.add(qbo);
  }

  /** Clusters of the customers on file at this address (none if 3+ — a hub). */
  private rootsForAddress(text: string, requireSuffix = false): string[] {
    const k = streetKey(text, requireSuffix);
    if (!k) return [];
    let owners = this.addrOwners.get(k);
    // Event without a unit vs. QBO with one: accept only a unique customer.
    if (!owners && k.endsWith('|')) {
      const hits = [...this.addrOwners].filter(([ak]) => ak.startsWith(k));
      if (hits.length === 1) owners = hits[0][1];
    }
    if (!owners || owners.size >= 3) return [];
    return [...new Set([...owners].map((q) => this.dsu.find(`qbo:${q}`)))];
  }

  /** Every cluster the subject plausibly belongs to (hard keys + unique soft name). */
  rootsFor(s: Subject): Set<string> {
    const roots = new Set<string>();
    for (const p of s.phones ?? []) {
      const n = normPhone(p);
      if (n && !this.own.has(n) && !this.hubs.has(`phone:${n}`)) roots.add(this.dsu.find(`phone:${n}`));
    }
    for (const e of s.emails ?? []) {
      const k = `email:${e.toLowerCase()}`;
      if (!this.hubs.has(k)) roots.add(this.dsu.find(k));
    }
    if (s.qboId) roots.add(this.dsu.find(`qbo:${s.qboId}`));
    if (s.emailThreadId) {
      const k = this.emailThreadKey.get(s.emailThreadId);
      if (k) roots.add(this.dsu.find(k));
    }
    if (s.address) for (const r of this.rootsForAddress(s.address)) roots.add(r);
    for (const n of s.names ?? []) {
      const soft = this.softName(n);
      if (soft) roots.add(this.dsu.find(soft));
    }
    return roots;
  }

  /**
   * Phone/email → cluster id, for clusters that join two or more of them
   * (a customer's second phone, their email). The command center groups a
   * person's items with it (@aac/items group.ts). Ids are per run.
   */
  contactClusters(): Record<string, string> {
    const byRoot = new Map<string, string[]>();
    for (const k of this.dsu.keys()) {
      if (!k.startsWith('phone:') && !k.startsWith('email:')) continue;
      if (this.hubs.has(k)) continue;
      const r = this.dsu.find(k);
      byRoot.set(r, [...(byRoot.get(r) ?? []), k]);
    }
    const out: Record<string, string> = {};
    for (const [r, ks] of byRoot) {
      if (ks.length < 2) continue;
      for (const k of ks) out[k.slice(k.indexOf(':') + 1)] = r;
    }
    return out;
  }

  /** Every upcoming booked job across the subject's clusters. */
  bookingsFor(s: Subject): BookedJob[] {
    const seen = new Map<string, BookedJob>();
    for (const r of this.rootsFor(s)) for (const j of this.bookedByRoot.get(r) ?? []) seen.set(j.eventId, j);
    return [...seen.values()];
  }

  /** Most recently created upcoming booked job across the subject's clusters. */
  bookingFor(s: Subject, excludeEventId?: string): BookedJob | null {
    let best: BookedJob | null = null;
    for (const j of this.bookingsFor(s)) {
      if (j.eventId === excludeEventId) continue;
      if (!best || j.createdMs > best.createdMs) best = j;
    }
    return best;
  }

  /** Latest inbound / outbound contact across every channel of the subject's clusters. */
  activity(s: Subject): { lastInboundMs: number; lastOutboundMs: number } {
    let lastInboundMs = 0;
    let lastOutboundMs = 0;
    for (const r of this.rootsFor(s)) {
      const a = this.activityByRoot.get(r);
      if (!a) continue;
      lastInboundMs = Math.max(lastInboundMs, a.in);
      lastOutboundMs = Math.max(lastOutboundMs, a.out);
    }
    return { lastInboundMs, lastOutboundMs };
  }

  /** Phones/emails/QBO ids of every cluster with an upcoming booking (render filters on these). */
  bookedClusters(): Array<{ phones: string[]; emails: string[]; qboIds: string[]; job: BookedJob }> {
    const members = new Map<string, string[]>();
    for (const k of this.dsu.keys()) {
      const r = this.dsu.find(k);
      if (!this.bookedByRoot.has(r)) continue;
      if (!members.has(r)) members.set(r, []);
      members.get(r)!.push(k);
    }
    return [...members].map(([r, ks]) => {
      const jobs = this.bookedByRoot.get(r)!;
      return {
        phones: ks.filter((k) => k.startsWith('phone:')).map((k) => k.slice(6)),
        emails: ks.filter((k) => k.startsWith('email:')).map((k) => k.slice(6)),
        qboIds: ks.filter((k) => k.startsWith('qbo:')).map((k) => k.slice(4)),
        job: jobs.reduce((a, b) => (b.createdMs > a.createdMs ? b : a)),
      };
    });
  }
}

// ── booked-customer policy ───────────────────────────────────────────

export interface Xref extends Subject {
  /** When the thing this finding is about happened (last inbound, estimate date, …). */
  evidenceAt?: string;
}

interface Suppressible {
  id: string;
  section: string;
  severity: 'red' | 'yellow' | 'info';
  title: string;
  source: string;
  detail?: string;
  customer?: string;
  phone?: string;
  xref?: Xref;
}

export interface SuppressedFinding {
  id: string;
  section: string;
  source: string;
  title: string;
  customer?: string;
  reason: string;
}

/** Findings whose whole point is getting the customer closed/scheduled. */
const CLOSING_SECTIONS = new Set(['stale_estimate', 'deal_closer', 'quote_promised', 'quote_gap', 'message_draft']);
/** Open-ended conversation findings — a booked customer can still have a real question. */
const CONVERSATION_SECTIONS = new Set(['conversation']);
/** A closing finding whose evidence predates the booking by at most this is resolved by it. */
const CLOSING_SLACK_DAYS = 7;

const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Drop (or, when the customer wrote after the booking and nobody answered,
 * downgrade to info) scheduling/closing findings for customers who already
 * have an upcoming green job. Returns what was dropped, with reasons, so the
 * dashboard can show a collapsed audit list instead of silently hiding.
 */
export function applyBookedSuppression<F extends Suppressible>(
  findings: F[],
  idx: IdentityIndex,
): { kept: F[]; suppressed: SuppressedFinding[] } {
  const kept: F[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const closing = CLOSING_SECTIONS.has(f.section);
    if (!closing && !CONVERSATION_SECTIONS.has(f.section)) {
      kept.push(f);
      continue;
    }
    const subject: Subject = {
      ...f.xref,
      phones: [...(f.xref?.phones ?? []), ...(f.phone ? [f.phone] : [])],
      names: [...(f.xref?.names ?? []), ...(f.customer ? [f.customer] : [])],
    };
    const job = idx.bookingFor(subject);
    if (!job) {
      kept.push(f);
      continue;
    }
    const evMs = f.xref?.evidenceAt ? new Date(f.xref.evidenceAt).getTime() : NaN;
    const { lastOutboundMs } = idx.activity(subject);
    const booked = `"${job.summary}" ${job.start.slice(0, 10)}${job.createdMs ? ` (booked ${fmtDay(job.createdMs)})` : ''}`;
    let reason: string | null = null;
    if (Number.isFinite(evMs)) {
      if (job.createdMs >= evMs) reason = `booked ${booked} after this (${fmtDay(evMs)})`;
      else if (lastOutboundMs >= evMs) reason = `booked ${booked}; you've been in touch since (${fmtDay(lastOutboundMs)})`;
      else if (closing && job.createdMs >= evMs - CLOSING_SLACK_DAYS * DAY)
        reason = `booked ${booked}; the booking closed this`;
    }
    if (reason) {
      if (f.source === 'D5') reason += ' — estimate still Pending in QBO, mark it Accepted';
      suppressed.push({ id: f.id, section: f.section, source: f.source, title: f.title, customer: f.customer, reason });
      continue;
    }
    f.severity = 'info';
    f.detail = `[Already booked: ${booked} — but they wrote after the booking and nobody has answered; skim for a reschedule/cancel] ${f.detail ?? ''}`.trim();
    kept.push(f);
  }
  return { kept, suppressed };
}
