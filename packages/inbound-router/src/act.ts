/**
 * Phase 4: run the drafters for the routes that are live. Each live route
 * replaces an old path (the worker stops that path when the flag is on).
 *
 * - intake: first-touch intake, CT routing, and a first-touch decline go to
 *   message-drafts' processRoutedIntake with this read, so intake makes one
 *   draft-only call instead of classifying and reading the photos again.
 */
import { keys } from '@aac/shared-utils/redis';
import { processRoutedIntake, type RoutedIntake } from '@aac/message-drafts';
import type { Referral } from '@aac/quoting';
import type { Thread } from './read.js';
import { LIVE_ROUTES, type Acted, type InboundRead, type LiveRoute, type Route, type RouterDeps, type ThreadState } from './types.js';

export async function liveRoutes(deps: Pick<RouterDeps, 'redis'>): Promise<Set<LiveRoute>> {
  const raw = (await deps.redis.get<string>(keys.inboundRouterLive)) ?? '';
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is LiveRoute => (LIVE_ROUTES as readonly string[]).includes(s)),
  );
}

/** The customer's side of the thread as intake needs it. */
export function routedIntake(
  route: RoutedIntake['route'],
  read: InboundRead,
  thread: Thread,
  referrals: Map<string, Referral>,
  burstFromMs: number,
): RoutedIntake {
  const inbound = thread.messages
    .filter((m) => m.direction === 'incoming')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const voicemails = thread.calls
    .filter((c) => c.direction === 'incoming' && thread.voicemails.has(c.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((c) => `[voicemail transcript] ${thread.voicemails.get(c.id)}`);
  // Oldest first, in the order each message attached them (inboundPhotos is newest first).
  const photos = inbound.flatMap((m) =>
    (m.media ?? []).flatMap((x, i) => (!x.type || x.type.startsWith('image/') ? [{ key: `${m.id}:${i}`, url: x.url }] : [])),
  );
  return {
    route,
    verdict: read.canHelp.verdict,
    reason: read.canHelp.reason,
    question: read.canHelp.question,
    referrals: read.canHelp.referralIds.flatMap((id) => {
      const r = referrals.get(id);
      return r ? [`${r.name}${r.phone ? ` (${r.phone})` : ''}`] : [];
    }),
    entities: read.entities,
    customerText: [...inbound.map((m) => (m.text ?? '').trim()).filter(Boolean), ...voicemails].join('\n'),
    mediaCount: inbound.reduce((n, m) => n + (m.media?.length ?? 0), 0),
    photoNotes: photos.map((p) => read.photos[p.key]).filter((d): d is string => !!d),
    mediaUrls: photos.map((p) => p.url),
    inquiryAt: burstFromMs,
  };
}

/** Run the live routes' drafters. Never throws past a drafter's own error. */
export async function act(
  deps: RouterDeps,
  phone: string,
  live: Set<LiveRoute>,
  ctx: {
    read: InboundRead;
    thread: Thread;
    state: ThreadState;
    routes: Route[];
    referrals: Map<string, Referral>;
    burstFromMs: number;
  },
): Promise<Acted[]> {
  const acted: Acted[] = [];
  if (!deps.drafts) return acted;
  if (live.has('intake')) {
    // A decline before Matt has said anything is intake's (the kind first reply).
    const firstReply = !ctx.state.mattEngaged && !ctx.state.intakeDone;
    const r = ctx.routes.find(
      (x) => x.route === 'intake' || x.route === 'ct-routing' || (x.route === 'decline' && firstReply),
    );
    if (r) {
      const o = await processRoutedIntake(
        deps.drafts,
        phone,
        routedIntake(r.route as RoutedIntake['route'], ctx.read, ctx.thread, ctx.referrals, ctx.burstFromMs),
      );
      acted.push({ route: r.route, outcome: o.kind, ...(o.kind === 'drafted' ? {} : { reason: o.reason }) });
    }
  }
  return acted;
}
