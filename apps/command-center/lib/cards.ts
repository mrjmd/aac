import type { QBCustomer } from "@aac/api-clients/quickbooks";
import {
  buildCustomerTimeline,
  customerProfile,
  nudgeStatus,
  fetchEmailPart,
  fetchQboPart,
  fetchQuoPart,
  trimCustomer,
  trimEvent,
  type QboPart,
  type QuoPart,
  type TimelineEmail,
  type TimelineEvent,
} from "@aac/customers";
import { type InvoiceNudge } from "@aac/items";
import { easternDate } from "@aac/shared-utils/eastern";
import { getCashPosition, getMonthInvoices, getTechUtilization, type CashPosition, type TechWeek } from "@aac/metrics";
import { getCalendar, technicianEmails } from "./calendar";
import { getGmail, getQuo } from "./customers";
import { getQuickBooks } from "./quickbooks";
import { readSnapshot, refreshSnapshot, snapshot, type Snapshot } from "./snapshots";
import { CI_CARD, CI_MAX_AGE_MS, fetchCiStatus } from "./system-health";
import type { CiStatus } from "./system-rules";

const MIN = 60_000;

/** One overdue invoice on the nudge ladder; `next` is null when every reached rung is covered. */
export type NudgeRow = Omit<InvoiceNudge, "next"> & { next: InvoiceNudge["next"] | null };

/**
 * Every saved card the command center shows: its snapshot name, how old it
 * may get before a view triggers a background refresh, and how to read the
 * source. The refresh button and API resolve names only through here, so a
 * request can't make the server fetch anything else.
 */
interface Card<T> {
  name: string;
  maxAgeMs: number;
  fetch: () => Promise<T>;
}

/** The calendar index starts before the business's first job. */
const CALENDAR_FROM = "2024-01-01T00:00:00Z";
const CALENDAR_AHEAD_DAYS = 180;

export const cards = {
  cash: (): Card<CashPosition> => ({
    name: "money:cash",
    maxAgeMs: 15 * MIN,
    fetch: () => getCashPosition(getQuickBooks(), easternDate(new Date())),
  }),
  techWeeks: (): Card<TechWeek[]> => ({
    name: "jobs:tech-weeks",
    maxAgeMs: 15 * MIN,
    fetch: () => getTechUtilization(getCalendar(), technicianEmails(), easternDate(new Date())),
  }),
  customerIndex: (): Card<QBCustomer[]> => ({
    name: "customers:index",
    maxAgeMs: 6 * 60 * MIN,
    fetch: async () => (await getQuickBooks().listAllCustomers({ includeInactive: true })).map(trimCustomer),
  }),
  /** Every calendar event, shared by all customer pages (matched locally). */
  calendarIndex: (): Card<TimelineEvent[]> => ({
    name: "calendar:index",
    maxAgeMs: 30 * MIN,
    fetch: async () =>
      (
        await getCalendar().listEvents({
          timeMin: CALENDAR_FROM,
          timeMax: new Date(Date.now() + CALENDAR_AHEAD_DAYS * 86_400_000).toISOString(),
        })
      ).map(trimEvent),
  }),
  /** Every overdue invoice with its place on the 7/14/30/45 nudge ladder. */
  nudges: (): Card<NudgeRow[]> => ({
    name: "money:nudges",
    maxAgeMs: 30 * MIN,
    fetch: fetchNudges,
  }),
  /** Invoice date and total for every invoice since the chart's year-ago start (This month: revenue, winter gate). */
  monthInvoices: (): Card<Array<{ TxnDate?: string; TotalAmt?: number }>> => ({
    name: "month:invoices",
    maxAgeMs: 60 * MIN,
    fetch: async () => (await getMonthInvoices(getQuickBooks())).map((i) => ({ TxnDate: i.TxnDate, TotalAmt: i.TotalAmt })),
  }),
  /** CI on main (GitHub Actions "CI" / "check"). Read only by refresh and the warm cron, never on page load. */
  ci: (): Card<CiStatus> => ({
    name: CI_CARD,
    maxAgeMs: CI_MAX_AGE_MS,
    fetch: fetchCiStatus,
  }),
  customerQbo: (id: string): Card<QboPart | null> => ({
    name: `customer:${id}:qbo`,
    maxAgeMs: 30 * MIN,
    fetch: () => fetchQboPart(getQuickBooks(), id),
  }),
  customerQuo: (id: string): Card<QuoPart> => ({
    name: `customer:${id}:quo`,
    maxAgeMs: 30 * MIN,
    fetch: async () => {
      const quo = getQuo();
      if (!quo) throw new Error("Quo is not configured (QUO_API_KEY / QUO_PHONE_NUMBER)");
      return fetchQuoPart(quo, (await profileOf(id))?.phones ?? []);
    },
  }),
  customerEmail: (id: string): Card<TimelineEmail[]> => ({
    name: `customer:${id}:email`,
    maxAgeMs: 30 * MIN,
    fetch: async () => {
      const gmail = getGmail();
      if (!gmail) throw new Error("Gmail is not configured (GOOGLE_* env)");
      return fetchEmailPart(gmail, (await profileOf(id))?.emails ?? []);
    },
  }),
};

/**
 * Overdue invoices, each customer's texts, calls and email read through
 * their saved customer cards (which also warms those pages), then the
 * ladder. A customer whose QBO, Quo or Gmail part fails is laddered on what's left.
 */
async function fetchNudges(): Promise<NudgeRow[]> {
  const today = easternDate(new Date());
  const overdue = (await getQuickBooks().listOpenInvoices()).filter((i) => i.DueDate && i.DueDate < today && (i.Balance ?? 0) > 0);
  const byCustomer = new Map<string, typeof overdue>();
  for (const inv of overdue) byCustomer.set(inv.CustomerRef.value, [...(byCustomer.get(inv.CustomerRef.value) ?? []), inv]);
  const rows: NudgeRow[] = [];
  const ids = [...byCustomer.keys()];
  // Four customers at a time keeps Quo and Gmail under their rate limits.
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(
      ids.slice(i, i + 4).map(async (id) => {
        const qbo = await loadSafe(cards.customerQbo(id));
        const part = qbo.snap?.data;
        // No customer record: still ladder the invoice, on no touches, rather than drop it.
        const [quo, email] = part
          ? await Promise.all([loadSafe(cards.customerQuo(id)), loadSafe(cards.customerEmail(id))])
          : [null, null];
        const t = buildCustomerTimeline({
          customer: part?.customer ?? { Id: id, DisplayName: byCustomer.get(id)![0].CustomerRef.name ?? id },
          estimates: part?.estimates ?? [],
          invoices: part?.invoices ?? [],
          payments: part?.payments ?? [],
          messages: quo?.snap?.data.messages ?? [],
          calls: quo?.snap?.data.calls ?? [],
          emails: email?.snap?.data ?? [],
          events: [],
          today,
          now: new Date(),
        });
        for (const inv of byCustomer.get(id) ?? []) {
          const s = nudgeStatus(inv.DueDate!, t.entries, today);
          rows.push({
            invoiceId: inv.Id!,
            doc: inv.DocNumber ?? inv.Id!,
            customer: inv.CustomerRef.name ?? t.profile.name,
            ...(t.profile.phones[0] ? { phone: t.profile.phones[0] } : {}),
            balance: inv.Balance ?? 0,
            dueDate: inv.DueDate!,
            ...s,
          });
        }
      }),
    );
  }
  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/** Phones and emails come from the saved QBO part (fetched if missing). */
async function profileOf(id: string) {
  const qbo = (await readSnapshot<QboPart | null>(cards.customerQbo(id).name)) ?? (await load(cards.customerQbo(id)));
  return qbo.data ? customerProfile(qbo.data.customer) : null;
}

/** Saved snapshot (stale → refreshed after the response). */
export function load<T>(card: Card<T>): Promise<Snapshot<T>> {
  return snapshot(card.name, card.fetch, card.maxAgeMs);
}

/** Like load, but a failing source becomes an error the card can show. */
export async function loadSafe<T>(card: Card<T>): Promise<{ snap: Snapshot<T> | null; error: string | null }> {
  try {
    return { snap: await load(card), error: null };
  } catch (err) {
    return { snap: null, error: (err as Error).message };
  }
}

/** Resolve a snapshot name from the refresh button back to its card. */
/** The cards every page shares (not per customer): the warm cron re-reads these, and refresh resolves them by name. */
export function sharedCards(): Card<unknown>[] {
  return [cards.cash(), cards.techWeeks(), cards.customerIndex(), cards.calendarIndex(), cards.nudges(), cards.ci(), cards.monthInvoices()] as Card<unknown>[];
}

export function cardByName(name: string): Card<unknown> | null {
  const fixed = sharedCards().find((c) => c.name === name);
  if (fixed) return fixed as Card<unknown>;
  const m = /^customer:(\d+):(qbo|quo|email)$/.exec(name);
  if (!m) return null;
  const [, id, part] = m;
  return (part === "qbo" ? cards.customerQbo(id) : part === "quo" ? cards.customerQuo(id) : cards.customerEmail(id)) as Card<unknown>;
}

export async function refreshCard(name: string): Promise<Snapshot<unknown> | null> {
  const card = cardByName(name);
  return card ? refreshSnapshot(card.name, card.fetch) : null;
}
