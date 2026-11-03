import type { QBCustomer } from "@aac/api-clients/quickbooks";
import {
  customerProfile,
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
import { nyDate } from "@aac/items";
import { getCashPosition, getTechUtilization, type CashPosition, type TechWeek } from "@aac/metrics";
import { getCalendar, technicianEmails } from "./calendar";
import { getGmail, getQuo } from "./customers";
import { getQuickBooks } from "./quickbooks";
import { readSnapshot, refreshSnapshot, snapshot, type Snapshot } from "./snapshots";

const MIN = 60_000;

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
    fetch: () => getCashPosition(getQuickBooks(), nyDate(new Date())),
  }),
  techWeeks: (): Card<TechWeek[]> => ({
    name: "jobs:tech-weeks",
    maxAgeMs: 15 * MIN,
    fetch: () => getTechUtilization(getCalendar(), technicianEmails(), nyDate(new Date())),
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
export function cardByName(name: string): Card<unknown> | null {
  const fixed = [cards.cash(), cards.techWeeks(), cards.customerIndex(), cards.calendarIndex()].find((c) => c.name === name);
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
