import { GmailClient } from "@aac/api-clients/gmail";
import type { QBCustomer } from "@aac/api-clients/quickbooks";
import { QuoClient } from "@aac/api-clients/quo";
import type { TimelineDeps } from "@aac/customers";
import { getCalendar } from "./calendar";
import { getQuickBooks } from "./quickbooks";

/**
 * Clients for the Customer page. QBO defines the customer; Quo, Gmail and
 * the calendar are optional and show as a source error when unconfigured
 * or down. Gmail reads matt@attackacrack.com with the same Google token as
 * the calendar (the worker's quote-email poller uses it the same way).
 */
export function getTimelineDeps(): TimelineDeps {
  const { QUO_API_KEY, QUO_PHONE_NUMBER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  const google =
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN
      ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN }
      : null;
  return {
    qb: getQuickBooks(),
    quo: QUO_API_KEY && QUO_PHONE_NUMBER ? new QuoClient({ apiKey: QUO_API_KEY, phoneNumber: QUO_PHONE_NUMBER }) : undefined,
    gmail: google ? new GmailClient({ oauth: google }) : undefined,
    calendar: google ? getCalendar() : undefined,
  };
}

/** The full customer list changes rarely; keep it per server instance for 10 minutes. */
const LIST_TTL_MS = 10 * 60_000;
let cached: { at: number; customers: QBCustomer[] } | null = null;

export async function allCustomers(): Promise<QBCustomer[]> {
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.customers;
  const customers = await getQuickBooks().listAllCustomers({ includeInactive: true });
  cached = { at: Date.now(), customers };
  return customers;
}
