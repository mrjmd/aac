/**
 * Runtime field context (owner process rule 2026-10-18): recover the
 * assessment chain live — calendar event + Matt↔Mike debrief + photos Mike
 * attached to the event. Holdout-validated: assessment-sourced cases went
 * 60% → 80% exact with this supplied. Ported from tools/src/drafter/run.ts.
 */
import type { QuoClient, QuoMessage, QuoCall } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import {
  matchEventsToCustomer,
  inDebriefWindow,
  buildFieldExtractionPrompt,
  parseFieldExtraction,
  formatFieldContext,
  type FieldEvidence,
} from '@aac/quoting';
import { generateWithRetry } from './gemini.js';
import {
  FIELD_LOOKBACK_DAYS,
  MAX_DEBRIEF_CALLS,
  MAX_TECH_PHOTOS,
  MAX_TRANSCRIPT_CHARS,
  MIKE_EMAILS,
  MIKE_PHONE,
  type DrafterDeps,
} from './types.js';

export interface FieldChannel {
  events: Array<{
    id: string;
    summary?: string;
    location?: string;
    description?: string;
    colorId?: string;
    startMs: number;
    attachments: Array<{ fileId?: string; title: string; mimeType?: string }>;
  }>;
  mikeTexts: QuoMessage[];
  mikeCalls: QuoCall[];
  drive: GoogleDriveClient;
}

/**
 * One fetch per run: recent calendar events + the Matt↔Mike thread/calls.
 * Returns null (channel disabled) when calendar/drive deps are absent or
 * any fetch fails — the drafter degrades to photos+thread only.
 */
export async function loadFieldChannel(deps: DrafterDeps): Promise<FieldChannel | null> {
  if (!deps.calendar || !deps.drive) return null;
  try {
    const now = deps.now();
    const rawEvents = await deps.calendar.listEvents({
      timeMin: new Date(now - FIELD_LOOKBACK_DAYS * 86_400_000).toISOString(),
      timeMax: new Date(now + 86_400_000).toISOString(),
    });
    const events = rawEvents.map((e) => ({
      id: e.id,
      summary: e.summary,
      location: e.location,
      description: e.description,
      colorId: e.colorId,
      startMs: new Date(e.start).getTime(),
      attachments: e.attachments,
    }));
    const mikeTexts = (await deps.quo.listMessages({ participantE164: MIKE_PHONE, maxResults: 100 })).data;
    const mikeCalls = (await deps.quo.listCalls({ participantE164: MIKE_PHONE, maxResults: 100 })).data;
    deps.log(
      `field channel: ${events.length} events (${FIELD_LOOKBACK_DAYS}d), ${mikeTexts.length} Mike texts, ${mikeCalls.length} Mike calls`,
    );
    return { events, mikeTexts, mikeCalls, drive: deps.drive };
  } catch (err) {
    deps.log(`field channel unavailable (${(err as Error).message.slice(0, 100)}) — drafting without it`);
    return null;
  }
}

/**
 * Recover the assessment chain for one customer: matched calendar events,
 * debrief texts/call-transcripts, Mike-attached event photos (Drive owner
 * check — Matt also attaches customer duplicates, which are excluded), and
 * an LLM extraction of the field findings. Never throws; empty on no match.
 */
export async function fetchFieldContext(input: {
  channel: FieldChannel;
  quo: QuoClient;
  gemini: GeminiClient;
  customerName: string;
  customerPhotoCount: number;
}): Promise<{ fieldBlock: string; techParts: Array<{ mimeType: string; base64: string }>; eventCount: number }> {
  const { channel, quo, gemini, customerName } = input;
  const none = { fieldBlock: '', techParts: [], eventCount: 0 };
  const matches = matchEventsToCustomer(channel.events, customerName);
  if (!matches.length) return none;
  const visitTimes = matches.map((m) => m.startMs);

  // debrief texts: name mention anywhere recent, or anything near a visit
  const tokens = customerName.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  const texts = channel.mikeTexts
    .filter((m) => {
      const at = new Date(m.createdAt).getTime();
      const nearVisit = visitTimes.some((v) => inDebriefWindow(at, v));
      const mention = tokens.some((t) => (m.text ?? '').toLowerCase().includes(t));
      return nearVisit || mention;
    })
    .map((m) => ({ at: m.createdAt, fromOwner: m.direction === 'outgoing', text: m.text ?? '' }))
    .filter((t) => t.text.trim());

  // debrief calls near a visit → transcripts
  const calls = channel.mikeCalls
    .filter((c) => c.status === 'completed' && (c.duration ?? 0) >= 40)
    .filter((c) => visitTimes.some((v) => inDebriefWindow(new Date(c.createdAt).getTime(), v)))
    .slice(0, MAX_DEBRIEF_CALLS);
  const callTranscripts: Array<{ at: string; durationMin: number; dialogue: string }> = [];
  for (const c of calls) {
    const t = await quo.getCallTranscript(c.id).catch(() => null);
    if (!t?.dialogue?.length) continue;
    let dialogue = t.dialogue
      .map((d) => `${d.identifier === MIKE_PHONE ? 'MIKE' : 'MATT'}: ${d.content}`)
      .join('\n');
    if (dialogue.length > MAX_TRANSCRIPT_CHARS) {
      dialogue = dialogue.slice(0, MAX_TRANSCRIPT_CHARS / 2) + '\n…\n' + dialogue.slice(-MAX_TRANSCRIPT_CHARS / 2);
    }
    callTranscripts.push({ at: c.createdAt, durationMin: Math.round((c.duration ?? 0) / 60), dialogue });
  }

  // technician photos attached to the matched events (owner = Mike only)
  const techParts: Array<{ mimeType: string; base64: string }> = [];
  for (const ev of matches) {
    const raw = channel.events.find((e) => e.id === ev.id);
    for (const a of raw?.attachments ?? []) {
      if (techParts.length >= MAX_TECH_PHOTOS) break;
      if (!a.fileId) continue;
      if (a.mimeType && !a.mimeType.startsWith('image/')) continue;
      const info = await channel.drive.getFileInfo(a.fileId);
      const owner = (info?.ownerEmail ?? info?.lastModifiedByEmail ?? '').toLowerCase();
      if (!MIKE_EMAILS.has(owner)) continue;
      const dl = await channel.drive.downloadFile(a.fileId);
      if (!dl || !dl.mimeType.startsWith('image/')) continue;
      techParts.push({ mimeType: dl.mimeType, base64: Buffer.from(dl.data).toString('base64') });
    }
  }

  if (!texts.length && !callTranscripts.length && !techParts.length) return none;

  let extraction = null;
  if (texts.length || callTranscripts.length) {
    const evidence: FieldEvidence = { events: matches, texts, callTranscripts };
    const raw = await generateWithRetry(gemini, buildFieldExtractionPrompt({ customerName, evidence }), {});
    extraction = parseFieldExtraction(raw);
  }

  return {
    fieldBlock: formatFieldContext({
      extraction,
      techPhotoCount: techParts.length,
      customerPhotoCount: input.customerPhotoCount,
    }),
    techParts,
    eventCount: matches.length,
  };
}
