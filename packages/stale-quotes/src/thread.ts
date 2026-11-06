// ── thread analysis ──────────────────────────────────────────────────
import type { QuoMessage } from '@aac/api-clients/quo';
import { DAY } from './types.js';

export interface ThreadFacts {
  messages: QuoMessage[];
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** Outbound "touches" since the last inbound (the unanswered run).
   *  Touch = outbound ≥3d post-quote after ≥72h silence (patterns.py). */
  unansweredTouches: number;
  touchesSinceQuote: number;
}

export function analyzeThread(messages: QuoMessage[], quoteMs: number): ThreadFacts {
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let lastInboundAt: number | null = null;
  let lastOutboundAt: number | null = null;
  let touchesSinceQuote = 0;
  let unansweredTouches = 0;
  let prevMsgAt = 0;
  for (const m of sorted) {
    const at = new Date(m.createdAt).getTime();
    if (m.direction === 'incoming') {
      lastInboundAt = at;
      unansweredTouches = 0;
    } else {
      lastOutboundAt = at;
      const isTouch = at >= quoteMs + 3 * DAY && at - prevMsgAt >= 72 * 3_600_000;
      if (isTouch) {
        touchesSinceQuote++;
        unansweredTouches++;
      }
    }
    prevMsgAt = at;
  }
  return { messages: sorted, lastInboundAt, lastOutboundAt, unansweredTouches, touchesSinceQuote };
}

/** The last 12 texts, oldest first, as the prompts read them. */
export function smsTailOf(messages: QuoMessage[]): string {
  return messages
    .slice(-12)
    .map((m) => `[${m.createdAt.slice(0, 10)} ${m.direction === 'outgoing' ? 'OUT' : 'IN'}] ${(m.text || '[media]').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
}
