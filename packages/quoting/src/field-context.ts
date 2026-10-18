/**
 * Runtime field context for post-assessment quote drafting.
 *
 * The owner's process rule (2026-10-18): when a quote needs more than the
 * customer's photos+thread, there was an assessment — a calendar event for
 * the customer plus an owner↔technician debrief (texts, a call, and/or
 * photos the technician attached to the event). At draft time the drafter
 * recovers that chain live: match recent calendar events to the customer,
 * pull the owner↔technician channel around the visit, and extract the
 * field findings (label-blind — there is no quote yet at runtime).
 *
 * Pure logic only: name matching, window math, prompt building, parsing.
 * Clients (Calendar, Quo, Drive, Gemini) are composed by the caller.
 */

const DAY = 86_400_000;

export interface FieldEventMatch {
  id: string;
  summary: string;
  startMs: number;
  colorId?: string;
  isAssessment: boolean;
}

export interface FieldEvidence {
  events: FieldEventMatch[];
  texts: Array<{ at: string; fromOwner: boolean; text: string }>;
  callTranscripts: Array<{ at: string; durationMin: number; dialogue: string }>;
}

export interface FieldExtraction {
  relevant: boolean;
  findings: string | null;
  quotes: string[];
}

/** Last name is a match on its own; first names need corroboration. */
export function nameTokens(customerName: string): { last: string[]; first: string[] } {
  const words = String(customerName ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4);
  if (words.length <= 1) return { last: words, first: [] };
  return { last: [words[words.length - 1]], first: words.slice(0, -1) };
}

/**
 * Match calendar events to a customer by name. Last-name hit matches any
 * event; first-name-only hits count only on assessment-colored events
 * (colorId 3) — same policy the corpus attribution validated.
 */
export function matchEventsToCustomer(
  events: Array<{ id: string; summary?: string; location?: string; description?: string; colorId?: string; startMs: number }>,
  customerName: string,
): FieldEventMatch[] {
  const { last, first } = nameTokens(customerName);
  if (!last.length) return [];
  return events
    .filter((e) => {
      const hay = `${e.summary ?? ''} ${e.location ?? ''} ${e.description ?? ''}`.toLowerCase();
      return last.some((t) => hay.includes(t)) || (String(e.colorId) === '3' && first.some((t) => hay.includes(t)));
    })
    .map((e) => ({
      id: e.id,
      summary: e.summary ?? '',
      startMs: e.startMs,
      colorId: e.colorId,
      isAssessment: String(e.colorId) === '3',
    }));
}

/** Debrief window around a visit: texts/calls land same-day to +2 days. */
export function inDebriefWindow(atMs: number, visitStartMs: number): boolean {
  return atMs >= visitStartMs - 0.5 * DAY && atMs <= visitStartMs + 2 * DAY;
}

/**
 * Extraction prompt — mirrors the corpus field-context pass in its BLIND
 * form (no quote lines exist at runtime, so there is nothing to leak).
 */
export function buildFieldExtractionPrompt(input: {
  customerName: string;
  evidence: FieldEvidence;
  technicianName?: string;
}): string {
  const tech = input.technicianName ?? 'Mike';
  const parts: string[] = [];
  for (const e of input.evidence.events) {
    parts.push(
      `CALENDAR [${e.isAssessment ? 'ASSESSMENT' : 'visit'}] ${new Date(e.startMs).toISOString().slice(0, 10)}: ${e.summary}`,
    );
  }
  for (const t of input.evidence.texts.slice(0, 40)) {
    parts.push(`TEXT ${t.at.slice(0, 10)} ${t.fromOwner ? 'OWNER' : tech.toUpperCase()}: ${t.text.slice(0, 300)}`);
  }
  for (const c of input.evidence.callTranscripts.slice(0, 4)) {
    parts.push(`CALL ${c.at.slice(0, 10)} (${c.durationMin}min):\n${c.dialogue}`);
  }
  return `You are extracting technician field findings ahead of a foundation-repair quote.

CUSTOMER: ${input.customerName}

Below are calendar events and owner↔technician texts/call-transcript excerpts around a recent site visit. ${tech} visits sites and reports back; the owner writes the quotes. Much of this traffic is about OTHER customers — only extract what is about ${input.customerName} (or clearly about their job/address).

Return strict JSON:
{"relevant": boolean, "findings": string|null, "quotes": string[]}
- relevant: true only if any evidence is clearly about this customer's job
- findings: 1-4 sentences — what the visit/debrief established that the customer's photos+thread alone would not show (scope, measurements, access, water sources, what ${tech} recommended)
- quotes: up to 3 short verbatim lines from the owner or ${tech} about this job

EVIDENCE:
${parts.join('\n\n')}`;
}

export function parseFieldExtraction(text: string): FieldExtraction | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<FieldExtraction>;
    const findings = typeof parsed.findings === 'string' ? parsed.findings.trim() : null;
    const empty = !findings || /^(none|null|n\/a)$/i.test(findings);
    if (parsed.relevant !== true || empty) return { relevant: false, findings: null, quotes: [] };
    return {
      relevant: true,
      findings,
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes.filter((q): q is string => typeof q === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** Render the draft-prompt block (same shape the holdout eval validated). */
export function formatFieldContext(input: {
  extraction: FieldExtraction | null;
  techPhotoCount: number;
  customerPhotoCount: number;
}): string {
  let block = '';
  if (input.extraction?.relevant && input.extraction.findings) {
    block += `\n\nFIELD CONTEXT (technician assessment debrief — owner↔technician channel):\n${input.extraction.findings}`;
    if (input.extraction.quotes.length) {
      block += `\nVerbatim: ${input.extraction.quotes.map((q) => `"${q}"`).join(' | ')}`;
    }
  }
  if (input.techPhotoCount > 0) {
    block += `\n\nTECHNICIAN PHOTOS: the last ${input.techPhotoCount} image(s) were taken by the technician on site (appended after the ${input.customerPhotoCount} customer photos).`;
  }
  return block;
}
