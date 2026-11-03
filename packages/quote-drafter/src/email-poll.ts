/**
 * T4 email channel (2026-10-29): scope changes arrive by email too, and
 * Gmail has no webhook here — the worker polls every 15 min. Inbound mail
 * whose sender matches an open quote's email becomes a synthetic trigger
 * event on the normal queue; debounce + the scope gate take it from there.
 *
 * Requires gmail.readonly on the worker's Google refresh token — scopes
 * freeze at mint, so a token without it needs a reauth
 * (tools/src/scratch/reauth-google.ts). Callers catch the scope error and
 * degrade to "email channel disabled".
 */
import type { Redis } from '@upstash/redis';
import type { GmailClient } from '@aac/api-clients/gmail';
import { keys } from '@aac/shared-utils/redis';
import { listOpenQuotes } from './open-quotes.js';
import type { TriggerEvent } from './types.js';

const EMAIL_QUERY = 'newer_than:2d -in:spam -in:sent -in:draft';
const EMAIL_SEEN_TTL_MS = 7 * 86_400_000;
const SNIPPET_MAX = 300;

/** Matt sends from either mailbox — his own mail is never a customer signal. */
const OUR_ADDRESSES = new Set(['matt@attackacrack.com', 'attackacrackma@gmail.com']);

export interface EmailPollSummary {
  openQuotes: number;
  scanned: number;
  enqueued: number;
}

export async function pollQuoteEmails(deps: {
  redis: Redis;
  gmail: GmailClient;
  log: (line: string) => void;
  now: () => number;
}): Promise<EmailPollSummary> {
  const { redis, gmail, log } = deps;
  const now = deps.now();
  const summary: EmailPollSummary = { openQuotes: 0, scanned: 0, enqueued: 0 };

  const open = await listOpenQuotes(redis);
  const byEmail = new Map<string, string>(); // email → phone
  for (const [phone, entry] of open) {
    if (entry.email) byEmail.set(entry.email.toLowerCase(), phone);
  }
  summary.openQuotes = byEmail.size;
  if (!byEmail.size) return summary;

  const messages = await gmail.listMessages({ query: EMAIL_QUERY, maxResults: 200 });
  summary.scanned = messages.length;
  for (const m of messages) {
    const phone = byEmail.get(m.fromAddress);
    if (!phone || OUR_ADDRESSES.has(m.fromAddress)) continue;
    const seen = await redis.hget<string>(keys.quoteEmailSeen, m.id);
    if (seen) continue;
    await redis.hset(keys.quoteEmailSeen, { [m.id]: new Date(now).toISOString() });
    const event: TriggerEvent = {
      phone,
      direction: 'incoming',
      at: m.at,
      hasMedia: m.attachments.length > 0,
      snippet: `${m.subject}: ${m.body || m.snippet}`.slice(0, SNIPPET_MAX),
      kind: 'email',
    };
    await redis.lpush(keys.quoteTriggerQueue, JSON.stringify(event));
    await redis.ltrim(keys.quoteTriggerQueue, 0, 999);
    summary.enqueued++;
    log(`email → trigger event: ${m.fromAddress} (${phone}) "${m.subject.slice(0, 60)}"`);
  }

  // prune old seen ids
  const seenAll = ((await redis.hgetall(keys.quoteEmailSeen)) ?? {}) as Record<string, string>;
  for (const [id, at] of Object.entries(seenAll)) {
    if (now - new Date(at).getTime() > EMAIL_SEEN_TTL_MS) {
      await redis.hdel(keys.quoteEmailSeen, id);
    }
  }
  return summary;
}
