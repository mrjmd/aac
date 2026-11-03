import { GmailClient } from "@aac/api-clients/gmail";
import { QuoClient } from "@aac/api-clients/quo";

/** Main business line, for the Customer page's texts and calls. Null when unconfigured. */
export function getQuo(): QuoClient | null {
  const { QUO_API_KEY, QUO_PHONE_NUMBER } = process.env;
  return QUO_API_KEY && QUO_PHONE_NUMBER ? new QuoClient({ apiKey: QUO_API_KEY, phoneNumber: QUO_PHONE_NUMBER }) : null;
}

/**
 * matt@attackacrack.com, with the same Google token as the calendar (the
 * worker's quote-email poller reads it the same way). Null when unconfigured.
 */
export function getGmail(): GmailClient | null {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN
    ? new GmailClient({
        oauth: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN },
      })
    : null;
}
