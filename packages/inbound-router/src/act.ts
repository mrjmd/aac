/**
 * Phase 4: run the drafters for the routes that are live. Each live route
 * replaces an old path (the worker stops that path when the flag is on).
 *
 * - intake: first-touch intake, CT routing, and a first-touch decline go to
 *   message-drafts' processRoutedIntake with this read, so intake makes one
 *   draft-only call instead of classifying and reading the photos again.
 * - quote: a quote or quote-gate route is handed to the quote loop as a
 *   routed job (T1 photos, T3 Matt's promise, T4 scope change on an open
 *   quote). The loop drafts it on its next tick under its own lock, with no
 *   debounce and no T4 gate call; it stops judging the customer's texts,
 *   photos and voicemails itself. A declined or need-info burst never gets
 *   a quote draft.
 * - referral: a decline once Matt is already talking to them (the customer
 *   adds work on the can't-help list mid-thread) goes to message-drafts'
 *   processRoutedReferral, which continues the thread and names the
 *   referral. Before this route nothing drafted these: the old quote
 *   trigger's decline note only fired when photos or a promise ran a quote.
 */
import { keys } from '@aac/shared-utils/redis';
import { AUTO_RE, processRoutedIntake, processRoutedReferral, type RoutedIntake, type RoutedReferral } from '@aac/message-drafts';
import { enqueueRoutedQuote, type RoutedQuoteJob } from '@aac/quote-drafter';
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

/** "Name (phone)" for each referral the read picked, best first. */
function referralNames(read: InboundRead, referrals: Map<string, Referral>): string[] {
  return read.canHelp.referralIds.flatMap((id) => {
    const r = referrals.get(id);
    return r ? [`${r.name}${r.phone ? ` (${r.phone})` : ''}`] : [];
  });
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
    referrals: referralNames(read, referrals),
    entities: read.entities,
    customerText: [...inbound.map((m) => (m.text ?? '').trim()).filter(Boolean), ...voicemails].join('\n'),
    mediaCount: inbound.reduce((n, m) => n + (m.media?.length ?? 0), 0),
    photoNotes: photos.map((p) => read.photos[p.key]).filter((d): d is string => !!d),
    // The read declines past the far-drive area; inside it, the drive is Matt's call.
    ...(read.propertyState === 'other' ? { flag: `property outside Massachusetts${read.entities.address ? ` (${read.entities.address})` : ''}, your call on the drive` } : {}),
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
  // A decline before Matt has said anything is intake's (the kind first reply).
  const firstReply = !ctx.state.mattEngaged && !ctx.state.intakeDone;
  if (live.has('intake') && deps.drafts) {
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
  if (live.has('referral') && deps.drafts && !firstReply) {
    const r = ctx.routes.find((x) => x.route === 'decline');
    if (r) {
      const o = await processRoutedReferral(deps.drafts, phone, routedReferral(ctx.read, ctx.thread, ctx.referrals, ctx.burstFromMs));
      acted.push({ route: r.route, outcome: o.kind, ...(o.kind === 'drafted' ? {} : { reason: o.reason }) });
    }
  }
  if (live.has('quote')) {
    const r = ctx.routes.find((x) => x.route === 'quote' || x.route === 'quote-gate');
    if (r) {
      await enqueueRoutedQuote(deps.redis, phone, routedQuote(r, ctx.state, ctx.thread, ctx.burstFromMs, deps.now?.() ?? Date.now()));
      acted.push({ route: r.route, outcome: 'queued' });
    }
  }
  return acted;
}

/** Thread lines the referral reply reads (Quo auto-replies dropped). */
const REFERRAL_THREAD_LINES = 16;

/** The conversation as the referral drafter needs it. */
export function routedReferral(read: InboundRead, thread: Thread, referrals: Map<string, Referral>, burstFromMs: number): RoutedReferral {
  const inBurst = (at: string) => new Date(at).getTime() >= burstFromMs;
  const msgs = thread.messages
    .filter((m) => (m.text ?? '').trim() || m.media?.length)
    .filter((m) => m.direction === 'incoming' || !AUTO_RE.test(m.text ?? ''))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const lines = msgs.map((m) => {
    const who = m.direction === 'incoming' ? 'CUSTOMER' : 'MATT';
    const photos = m.media?.length ? `[${m.media.length} photo(s)]` : '';
    return `${who}: ${[(m.text ?? '').replace(/\s+/g, ' ').trim(), photos].filter(Boolean).join(' ')}`;
  });
  const voicemails = thread.calls
    .filter((c) => c.direction === 'incoming' && inBurst(c.createdAt) && thread.voicemails.has(c.id))
    .map((c) => `CUSTOMER: [voicemail] ${thread.voicemails.get(c.id)}`);
  const photoNotes = msgs
    .filter((m) => m.direction === 'incoming' && inBurst(m.createdAt))
    .flatMap((m) => (m.media ?? []).map((_, i) => read.photos[`${m.id}:${i}`]))
    .filter((d): d is string => !!d);
  return {
    reason: read.canHelp.reason,
    referrals: referralNames(read, referrals),
    conversation: [...lines.slice(-REFERRAL_THREAD_LINES), ...voicemails],
    photoNotes,
  };
}

/** The quote loop's job for this burst. */
export function routedQuote(route: Route, state: ThreadState, thread: Thread, burstFromMs: number, nowMs: number): RoutedQuoteJob {
  const inBurst = (at: string) => new Date(at).getTime() >= burstFromMs;
  const texts = thread.messages.filter((m) => m.direction === 'incoming' && inBurst(m.createdAt));
  const voicemail = thread.calls.some((c) => c.direction === 'incoming' && inBurst(c.createdAt) && thread.voicemails.has(c.id));
  const channel = [
    state.newPhotos ? 'photos' : '',
    texts.some((m) => (m.text ?? '').trim()) ? 'text' : '',
    voicemail ? 'voicemail' : '',
  ].filter(Boolean).join(' + ') || 'text';
  return {
    trigger: route.route === 'quote-gate' ? 'T4' : state.newPhotos ? 'T1' : 'T3',
    why: route.why,
    channel,
    at: new Date(nowMs).toISOString(),
  };
}
