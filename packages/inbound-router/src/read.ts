/**
 * The read: load a customer's conversation, voicemails and photos once, ask
 * Gemini one structured question, save the answer at `inbound:read:{phone}`.
 *
 * Photos already described in an earlier read are passed as text, so a later
 * burst only sends Gemini the new ones. An unchanged fingerprint (no new
 * message or call since the saved read) means there is nothing to read.
 */
import { parseJsonText } from '@aac/api-clients/gemini';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import { buildCanHelpBlock, isRuleActive, type Referral, type StandingRule } from '@aac/quoting';
import { easternDate } from '@aac/shared-utils/eastern';
import { keys, ttl } from '@aac/shared-utils/redis';
import {
  INBOUND_INTENTS,
  type CanHelpVerdict,
  type InboundIntent,
  type InboundRead,
  type RouterDeps,
} from './types.js';

/** Most new photos sent per read (matches the drafters' MAX_PHOTOS). */
export const READ_MAX_PHOTOS = 6;
const THREAD_MESSAGES = 40;
const VOICEMAIL_PROBES = 3;

export interface Thread {
  messages: QuoMessage[];
  calls: QuoCall[];
  /** callId → transcript */
  voicemails: Map<string, string>;
}

export async function loadThread(quo: RouterDeps['quo'], phone: string): Promise<Thread> {
  const [msgs, calls] = await Promise.all([
    quo.listMessages({ participantE164: phone, maxResults: THREAD_MESSAGES }),
    quo.listCalls({ participantE164: phone, maxResults: 10 }),
  ]);
  const callList = calls.data ?? [];
  const voicemails = new Map<string, string>();
  const missed = callList
    .filter((c) => c.direction === 'incoming' && (c.duration ?? 0) === 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, VOICEMAIL_PROBES);
  for (const c of missed) {
    const vm = await quo.getCallVoicemail(c.id).catch(() => null);
    if (vm?.status === 'completed' && vm.transcript) voicemails.set(c.id, vm.transcript);
  }
  return { messages: msgs.data ?? [], calls: callList, voicemails };
}

/** Newest message and call: a saved read with the same fingerprint is current. */
export function threadFingerprint(thread: Thread): string {
  const newest = <T extends { id: string; createdAt: string }>(xs: T[]) =>
    xs.reduce<T | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  const m = newest(thread.messages);
  const c = newest(thread.calls);
  return `${m ? `${m.id}@${m.createdAt}` : '-'}|${c ? `${c.id}@${c.createdAt}` : '-'}|vm${thread.voicemails.size}`;
}

/** Oldest-first transcript, one line per message/call, photos tagged by cache key. */
export function threadLines(thread: Thread): string[] {
  const items: Array<{ at: string; line: string }> = [];
  for (const m of thread.messages) {
    const who = m.direction === 'incoming' ? 'CUSTOMER' : 'MATT';
    const media = (m.media ?? []).map((_, i) => `[photo ${m.id}:${i}]`).join(' ');
    items.push({ at: m.createdAt, line: `${m.createdAt.slice(0, 16)} ${who}: ${(m.text ?? '').trim()}${media ? ` ${media}` : ''}` });
  }
  for (const c of thread.calls) {
    const vm = thread.voicemails.get(c.id);
    const who = c.direction === 'incoming' ? 'CUSTOMER called' : 'MATT called';
    const how = vm ? `voicemail: ${vm}` : (c.duration ?? 0) > 0 ? `talked ${Math.round((c.duration ?? 0) / 60)} min` : 'no answer';
    items.push({ at: c.createdAt, line: `${c.createdAt.slice(0, 16)} ${who} (${how})` });
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : 1)).map((i) => i.line);
}

/** Inbound photo keys (`{messageId}:{index}`) with their URLs, newest first. */
export function inboundPhotos(thread: Thread): Array<{ key: string; url: string; type?: string }> {
  return thread.messages
    .filter((m) => m.direction === 'incoming')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .flatMap((m) => (m.media ?? []).map((x, i) => ({ key: `${m.id}:${i}`, url: x.url, type: x.type })))
    .filter((p) => !p.type || p.type.startsWith('image/'));
}

/** The rules as the read sees them: ids in brackets so the answer can name which fired. */
export function rulesForRead(rules: StandingRule[], referrals: Referral[], today: string): string {
  const active = rules.filter((r) => isRuleActive(r, today));
  const withIds = active.map((r) => ({ ...r, text: `[${r.id}] ${r.text}` }));
  const refsWithIds = referrals.map((r) => ({ ...r, name: `[${r.id}] ${r.name}` }));
  return buildCanHelpBlock({ rules: withIds, referrals: refsWithIds, today });
}

export function buildReadPrompt(args: {
  lines: string[];
  rulesBlock: string;
  knownPhotos: Array<{ key: string; description: string }>;
  newPhotoKeys: string[];
}): string {
  return `You read text conversations between Matt (owner of Attack A Crack, a Massachusetts foundation crack repair and concrete company) and one customer phone number. Read the whole thread and report what the customer needs. You draft nothing.

THE THREAD (oldest first; times UTC):
${args.lines.join('\n') || '(empty)'}

${args.rulesBlock}

PHOTOS ALREADY DESCRIBED (from an earlier read):
${args.knownPhotos.length ? args.knownPhotos.map((p) => `- ${p.key}: ${p.description}`).join('\n') : '(none)'}

NEW PHOTOS ATTACHED TO THIS REQUEST, in this order: ${args.newPhotoKeys.length ? args.newPhotoKeys.join(', ') : '(none)'}

Answer:
1. classification: "lead" (a homeowner or property contact with a real issue we might service, new or existing customer), "solicitation" (lead-gen, vendor pitch, marketing), or "other" (wrong number, personal, unclear).
2. propertyState: the PROPERTY's state, "MA", "CT", "other" or "unknown", from towns and addresses in the thread (area codes are not evidence).
3. entities: the customer's full name, the property address, and email, as given in the thread; null when not given.
4. intents: every one that applies to the customer's latest messages, from ${INBOUND_INTENTS.map((i) => `"${i}"`).join(', ')}.
   new_lead = first contact about an issue; quote_request = asks for a price or quote; photos_sent = sent photos of the issue; scope_change = changes or adds to work already quoted; scheduling_reply = about booking, confirming or moving a visit; question = any other question for Matt.
5. canHelp, judged from the text AND the photos against the rules above:
   verdict "cant-help" (what they need is on the can't-help list), "need-info" (it could go either way and ONE fact decides it), or "can-help" (plausibly crack repair or concrete work we do).
   ruleIds: the bracketed ids of the rules that decided it ([] for can-help). referralIds: bracketed ids of referrals that fit, best first ([] when none fits).
   reason: one sentence on what decided it. question: for need-info, the one deciding question; otherwise null.
6. photos: one short factual description per NEW photo (what surface, material, crack or damage, how big), keyed by its id.
7. summary: one sentence on where this customer stands.

Return ONLY JSON: {"classification": "...", "propertyState": "...", "entities": {"name": str|null, "address": str|null, "email": str|null}, "intents": [...], "canHelp": {"verdict": "...", "ruleIds": [...], "referralIds": [...], "reason": "...", "question": str|null}, "photos": {"<id>": "..."}, "summary": "..."}`;
}

interface RawRead {
  classification?: unknown;
  propertyState?: unknown;
  entities?: { name?: unknown; address?: unknown; email?: unknown };
  intents?: unknown;
  canHelp?: { verdict?: unknown; ruleIds?: unknown; referralIds?: unknown; reason?: unknown; question?: unknown };
  photos?: unknown;
  summary?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Validate the model's answer: unknown ids, intents and photo keys are dropped, never trusted. */
export function parseRead(
  raw: string,
  ctx: { ruleIds: Set<string>; referralIds: Set<string>; newPhotoKeys: string[] },
): Omit<InboundRead, 'phone' | 'at' | 'fingerprint'> | null {
  let r: RawRead;
  try {
    r = parseJsonText<RawRead>(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object') return null;
  const classification = r.classification === 'lead' || r.classification === 'solicitation' ? r.classification : 'other';
  const propertyState =
    r.propertyState === 'MA' || r.propertyState === 'CT' || r.propertyState === 'other' ? r.propertyState : 'unknown';
  const verdict: CanHelpVerdict =
    r.canHelp?.verdict === 'cant-help' || r.canHelp?.verdict === 'need-info' ? r.canHelp.verdict : 'can-help';
  const photos: Record<string, string> = {};
  if (r.photos && typeof r.photos === 'object') {
    for (const key of ctx.newPhotoKeys) {
      const d = str((r.photos as Record<string, unknown>)[key]);
      if (d) photos[key] = d;
    }
  }
  return {
    classification,
    propertyState,
    entities: { name: str(r.entities?.name), address: str(r.entities?.address), email: str(r.entities?.email) },
    intents: [...new Set(strList(r.intents).filter((i): i is InboundIntent => (INBOUND_INTENTS as string[]).includes(i)))],
    canHelp: {
      verdict,
      ruleIds: strList(r.canHelp?.ruleIds).filter((id) => ctx.ruleIds.has(id)),
      referralIds: strList(r.canHelp?.referralIds).filter((id) => ctx.referralIds.has(id)),
      reason: str(r.canHelp?.reason) ?? '',
      question: verdict === 'need-info' ? str(r.canHelp?.question) : null,
    },
    photos,
    summary: str(r.summary) ?? '',
  };
}

export type ReadOutcome =
  | { kind: 'read'; read: InboundRead; thread: Thread; photosRead: number }
  | { kind: 'unchanged'; read: InboundRead; thread: Thread }
  | { kind: 'failed'; reason: string; thread: Thread };

/** Read one phone's thread, reusing the saved read's photo descriptions; saves the result. */
export async function readInbound(deps: RouterDeps, phone: string, loaded?: Thread): Promise<ReadOutcome> {
  const now = deps.now?.() ?? Date.now();
  const thread = loaded ?? (await loadThread(deps.quo, phone));
  const fingerprint = threadFingerprint(thread);
  const prior = await deps.redis.get<InboundRead>(keys.inboundRead(phone));
  if (prior && prior.fingerprint === fingerprint) return { kind: 'unchanged', read: prior, thread };

  const today = easternDate(now);
  const [rules, referrals] = await Promise.all([deps.canHelp.rules(), deps.canHelp.referrals()]);
  const cached = prior?.photos ?? {};
  const photos = inboundPhotos(thread);
  const knownPhotos = photos.filter((p) => cached[p.key]).map((p) => ({ key: p.key, description: cached[p.key] }));

  const imageParts: Array<{ mimeType: string; base64: string }> = [];
  const newPhotoKeys: string[] = [];
  for (const p of photos.filter((x) => !cached[x.key])) {
    if (imageParts.length >= READ_MAX_PHOTOS) break;
    const dl = await deps.quo.downloadMessageMedia(p.url).catch(() => null);
    if (!dl || !dl.contentType.startsWith('image/')) continue;
    imageParts.push({ mimeType: dl.contentType, base64: Buffer.from(dl.data).toString('base64') });
    newPhotoKeys.push(p.key);
  }

  const prompt = buildReadPrompt({
    lines: threadLines(thread),
    rulesBlock: rulesForRead(rules, referrals, today),
    knownPhotos,
    newPhotoKeys,
  });
  let out: string;
  try {
    out = await deps.gemini.generateContent(prompt, {
      // Thinking shares the output budget; 4096 truncated a CT thread's JSON in the live replay.
      maxOutputTokens: 8192,
      imageParts,
      retries: 2,
      timeoutMs: 120_000,
    });
  } catch (err) {
    return { kind: 'failed', reason: `gemini: ${(err as Error).message}`, thread };
  }
  const parsed = parseRead(out, {
    ruleIds: new Set(rules.map((r) => r.id)),
    referralIds: new Set(referrals.map((r) => r.id)),
    newPhotoKeys,
  });
  if (!parsed) return { kind: 'failed', reason: 'unparseable read', thread };

  // Keep descriptions for photos still in the thread window.
  const live = new Set(photos.map((p) => p.key));
  const keptPhotos = Object.fromEntries(Object.entries(cached).filter(([k]) => live.has(k)));
  const read: InboundRead = {
    phone,
    at: new Date(now).toISOString(),
    fingerprint,
    ...parsed,
    photos: { ...keptPhotos, ...parsed.photos },
  };
  await deps.redis.set(keys.inboundRead(phone), JSON.stringify(read), { ex: ttl.inboundRead });
  return { kind: 'read', read, thread, photosRead: newPhotoKeys.length };
}
