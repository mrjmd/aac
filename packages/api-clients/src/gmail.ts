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
  /**
   * Retry tuning for rate-limit errors (429, or 403 quota/rate-limit).
   * Defaults: 6 attempts, 2s base delay doubling to a 60s cap — the
   * cumulative wait spans a full per-minute quota window, so a sweep that
   * exhausts 'Units per minute per user' resumes in the next window
   * instead of failing.
   */
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
}

export interface GmailAttachmentRef {
  /** Pass to downloadAttachment together with the message id. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
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
  attachments: GmailAttachmentRef[];
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

function isRateLimitError(err: unknown): boolean {
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = Number(e.code ?? e.status ?? e.response?.status ?? NaN);
  if (status === 429) return true;
  return status === 403 && /quota|rate ?limit/i.test(e.message ?? '');
}

function attachmentsOf(part: gmail_v1.Schema$MessagePart | undefined): GmailAttachmentRef[] {
  if (!part) return [];
  const refs: GmailAttachmentRef[] = [];
  if (part.filename && part.body?.attachmentId) {
    refs.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      sizeBytes: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) refs.push(...attachmentsOf(child));
  return refs;
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

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = this.config.retry?.maxAttempts ?? 6;
    let delay = this.config.retry?.baseDelayMs ?? 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= maxAttempts) throw err;
        log.warn('Gmail rate limited; backing off', { label, attempt, delayMs: delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  private mapMessage(msg: gmail_v1.Schema$Message): GmailMessage {
    const from = header(msg, 'From');
    const attachments = attachmentsOf(msg.payload);
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
      attachmentNames: attachments.map((a) => a.filename),
      attachments,
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
      const res = await this.withRetry('messages.list', () =>
        gmail.users.messages.list({
          userId: 'me',
          q: options.query,
          maxResults: Math.min(100, max - ids.length),
          pageToken,
        }),
      );
      for (const m of res.data.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken || (res.data.messages ?? []).length === 0) break;
    }

    const messages: GmailMessage[] = [];
    for (const id of ids) {
      const res = await this.withRetry('messages.get', () =>
        gmail.users.messages.get({ userId: 'me', id, format: 'full' }),
      );
      messages.push(this.mapMessage(res.data));
    }

    log.info('Listed Gmail messages', { query: options.query, count: messages.length });
    return messages;
  }

  /**
   * Download one attachment's bytes. Ids come from GmailMessage.attachments.
   * Returns null when Gmail returns no data for the id (expired/invalid).
   */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer | null> {
    const gmail = this.getClient();
    const res = await this.withRetry('attachments.get', () =>
      gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      }),
    );
    if (!res.data.data) return null;
    return Buffer.from(res.data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  /** The authenticated account's email address. */
  async getProfileEmail(): Promise<string> {
    const gmail = this.getClient();
    const res = await gmail.users.getProfile({ userId: 'me' });
    return (res.data.emailAddress ?? '').toLowerCase();
  }
}
