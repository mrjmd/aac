/**
 * Gmail client — read-only message listing and retrieval.
 *
 * First consumer: the triage dashboard email sweep (quote requests and
 * customer replies that arrive by email instead of SMS). Read-only by
 * design — nothing in the system sends email through this client.
 *
 * Auth: OAuth2 refresh token (same pattern as GoogleCalendarClient).
 * Requires the gmail.readonly scope on the token.
 *
 * Uses the `googleapis` package.
 */

import { google, type gmail_v1 } from 'googleapis';

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('gmail');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GmailConfig {
  oauth: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export interface GmailMessage {
  id: string;
  threadId: string;
  /** Raw From header, e.g. 'Jane Doe <jane@example.com>'. */
  from: string;
  /** Lowercased address part of From, e.g. 'jane@example.com'. */
  fromAddress: string;
  to: string[];
  subject: string;
  /** ISO timestamp (Gmail internalDate). */
  at: string;
  labelIds: string[];
  snippet: string;
  /** Decoded text/plain body (empty string when only HTML exists). */
  body: string;
  attachmentNames: string[];
}

export interface ListMessagesOptions {
  /** Gmail search query, e.g. 'newer_than:21d -in:spam'. */
  query: string;
  /** Max messages to return across pages (default 200). */
  maxResults?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x) => x.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? '';
}

function addressOf(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Depth-first search for the first text/plain part with a body. */
function plainTextOf(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = plainTextOf(child);
    if (found) return found;
  }
  return '';
}

function attachmentNamesOf(part: gmail_v1.Schema$MessagePart | undefined): string[] {
  if (!part) return [];
  const names: string[] = [];
  if (part.filename && part.body?.attachmentId) names.push(part.filename);
  for (const child of part.parts ?? []) names.push(...attachmentNamesOf(child));
  return names;
}

// ── Client ───────────────────────────────────────────────────────────

export class GmailClient {
  private _client: gmail_v1.Gmail | null = null;

  constructor(private config: GmailConfig) {}

  private getClient(): gmail_v1.Gmail {
    if (!this._client) {
      const oauth2 = new google.auth.OAuth2(
        this.config.oauth.clientId,
        this.config.oauth.clientSecret,
      );
      oauth2.setCredentials({ refresh_token: this.config.oauth.refreshToken });
      this._client = google.gmail({ version: 'v1', auth: oauth2 });
    }
    return this._client;
  }

  private mapMessage(msg: gmail_v1.Schema$Message): GmailMessage {
    const from = header(msg, 'From');
    return {
      id: msg.id ?? '',
      threadId: msg.threadId ?? '',
      from,
      fromAddress: addressOf(from),
      to: header(msg, 'To')
        .split(',')
        .map((t) => addressOf(t))
        .filter(Boolean),
      subject: header(msg, 'Subject'),
      at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '',
      labelIds: msg.labelIds ?? [],
      snippet: msg.snippet ?? '',
      body: plainTextOf(msg.payload),
      attachmentNames: attachmentNamesOf(msg.payload),
    };
  }

  /**
   * List full messages matching a Gmail search query, newest first (the
   * API's native order). Paginates users.messages.list, then fetches each
   * message with format=full to get headers + decoded text/plain body.
   */
  async listMessages(options: ListMessagesOptions): Promise<GmailMessage[]> {
    const gmail = this.getClient();
    const max = options.maxResults ?? 200;

    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < max) {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: options.query,
        maxResults: Math.min(100, max - ids.length),
        pageToken,
      });
      for (const m of res.data.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken || (res.data.messages ?? []).length === 0) break;
    }

    const messages: GmailMessage[] = [];
    for (const id of ids) {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      messages.push(this.mapMessage(res.data));
    }

    log.info('Listed Gmail messages', { query: options.query, count: messages.length });
    return messages;
  }

  /** The authenticated account's email address. */
  async getProfileEmail(): Promise<string> {
    const gmail = this.getClient();
    const res = await gmail.users.getProfile({ userId: 'me' });
    return (res.data.emailAddress ?? '').toLowerCase();
  }
}
