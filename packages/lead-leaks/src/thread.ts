import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import type { ThreadFacts } from './types.js';

/** A call this long or longer was a real conversation: its transcript goes to the model. */
export const TALK_SECONDS = 45;
/** An outgoing text this soon after a missed call (no voicemail) is the auto-text; Matt typing a reply takes longer. */
const AUTO_TEXT_MS = 60_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function answered(c: QuoCall): boolean {
  return c.status === 'completed' && (c.duration ?? 0) > 0 && !c.voicemail;
}

/** Pure: who spoke first and last, what they sent, and whether all we have is missed calls. */
export function threadFacts(messages: QuoMessage[], calls: QuoCall[]): ThreadFacts | null {
  type Touch = { at: string; who: 'them' | 'us'; text: string; real: boolean };
  const missedAt = calls.filter((c) => c.direction === 'incoming' && !answered(c) && !c.voicemail).map((c) => Date.parse(c.createdAt));
  // Quo's missed-call auto-text goes out within seconds of the missed call: not a human reply.
  const autoText = (m: QuoMessage) =>
    m.direction === 'outgoing' && missedAt.some((t) => Date.parse(m.createdAt) - t >= 0 && Date.parse(m.createdAt) - t <= AUTO_TEXT_MS);
  const touches: Touch[] = [
    ...messages.map((m) => {
      const n = m.media?.length ?? 0;
      const text = [m.text?.trim(), n ? `${n} photo${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ');
      return { at: m.createdAt, who: m.direction === 'incoming' ? ('them' as const) : ('us' as const), text, real: !autoText(m) };
    }),
    ...calls.map((c) => {
      const who = c.direction === 'incoming' ? ('them' as const) : ('us' as const);
      const talked = answered(c);
      const vm = !!c.voicemail;
      const what = talked ? `call, ${Math.max(1, Math.round((c.duration ?? 0) / 60))} min` : vm ? 'voicemail' : `${c.direction === 'incoming' ? 'missed' : 'unanswered'} call`;
      return { at: c.createdAt, who, text: what, real: talked || vm };
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const inbound = touches.filter((t) => t.who === 'them');
  if (!inbound.length) return null;
  // The auto-text isn't us speaking: the last word is the last real touch or anything from them.
  const spoken = touches.filter((t) => t.real || t.who === 'them');
  const last = spoken[spoken.length - 1]!;
  const lastInbound = inbound[inbound.length - 1]!;
  const inboundTexts = messages.filter((m) => m.direction === 'incoming').length;
  return {
    firstAt: touches[0]!.at,
    lastAt: last.at,
    lastWho: last.who,
    lastText: clip(lastInbound.text || 'message', 140),
    lastInboundAt: lastInbound.at,
    inboundTexts,
    photos: messages.filter((m) => m.direction === 'incoming').reduce((s, m) => s + (m.media?.length ?? 0), 0),
    missedOnly: inboundTexts === 0 && !inbound.some((t) => t.real) && !touches.some((t) => t.who === 'us' && t.real),
  };
}

/**
 * Pure: the thread as the model reads it, oldest first. Our automatic
 * missed-call text is just another outgoing message; the prompt says it
 * doesn't count as a reply.
 */
export function renderThread(
  messages: QuoMessage[],
  calls: QuoCall[],
  transcripts: Record<string, string[]>,
  voicemails: Record<string, string>,
): string {
  const rows: Array<{ at: string; line: string }> = [
    ...messages.map((m) => {
      const who = m.direction === 'incoming' ? 'THEM' : 'US';
      const n = m.media?.length ?? 0;
      return { at: m.createdAt, line: `${who}: ${clip(m.text?.trim() || '', 800)}${n ? ` [${n} photo${n > 1 ? 's' : ''}]` : ''}` };
    }),
    ...calls.map((c) => {
      const who = c.direction === 'incoming' ? 'THEM called' : 'WE called';
      const head = answered(c)
        ? `${who}, talked ${Math.round((c.duration ?? 0) / 60)} min`
        : c.voicemail
          ? `${who}, voicemail left`
          : `${who}, ${c.direction === 'incoming' ? 'missed' : 'no answer'}`;
      const vm = voicemails[c.id] ? `\n    voicemail: ${clip(voicemails[c.id]!, 600)}` : '';
      const tr = transcripts[c.id]?.length ? `\n    transcript:\n${transcripts[c.id]!.map((l) => `      ${l}`).join('\n')}` : '';
      return { at: c.createdAt, line: `${head}${vm}${tr}` };
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return rows.map((r) => `[${r.at.slice(0, 16).replace('T', ' ')}Z] ${r.line}`).join('\n');
}

/** The calls worth a transcript: real conversations, longest first, at most `max`. */
export function callsToTranscribe(calls: QuoCall[], max = 3): QuoCall[] {
  return calls
    .filter((c) => answered(c) && (c.duration ?? 0) >= TALK_SECONDS)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, max);
}
