/**
 * Backstop for a missed webhook (the 10/19 webhook auto-disable): every 1:1
 * conversation updated in the window whose newest customer message or call
 * is newer than the saved read gets its settle clock armed. Matt's own texts
 * don't arm it. Quo calls only; the read happens in the next tick.
 */
import { keys } from '@aac/shared-utils/redis';
import { INTERNAL } from '@aac/quote-drafter';
import type { InboundRead, RouterDeps } from './types.js';

export async function sweepInbound(deps: RouterDeps, opts: { hours?: number } = {}): Promise<string[]> {
  const now = deps.now?.() ?? Date.now();
  const since = now - (opts.hours ?? 6) * 3_600_000;
  const phones = new Map<string, number>(); // phone → last activity
  let pageToken: string | undefined;
  do {
    const res = await deps.quo.listConversations({ maxResults: 100, pageToken, updatedAfter: new Date(since) });
    for (const c of res.data ?? []) {
      const external = (c.participants ?? []).filter((p) => !INTERNAL.has(p));
      if (external.length === 1 && (c.participants ?? []).length <= 2 && external[0].startsWith('+')) {
        phones.set(external[0], Math.max(phones.get(external[0]) ?? 0, new Date(c.lastActivityAt).getTime() || 0));
      }
    }
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);

  const armed: string[] = [];
  for (const [phone, lastActivity] of phones) {
    const read = await deps.redis.get<InboundRead>(keys.inboundRead(phone));
    const readAt = read ? new Date(read.at).getTime() : 0;
    if (readAt >= lastActivity) continue; // nothing since the last read
    const [msgs, calls] = await Promise.all([
      deps.quo.listMessages({ participantE164: phone, maxResults: 10 }),
      deps.quo.listCalls({ participantE164: phone, maxResults: 5 }),
    ]);
    const lastIn = Math.max(
      0,
      ...[...(msgs.data ?? []), ...(calls.data ?? [])]
        .filter((x) => x.direction === 'incoming')
        .map((x) => new Date(x.createdAt).getTime()),
    );
    if (lastIn < since || readAt >= lastIn) continue;
    await deps.redis.hsetnx(keys.inboundFirst, phone, lastIn);
    await deps.redis.zadd(keys.inboundDue, { nx: true }, { score: now, member: phone });
    armed.push(phone);
  }
  return armed;
}
