import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GeminiClient } from '@aac/api-clients';
import {
  buildEventDescription,
  type BuildEventDescriptionDeps,
  type BuildEventDescriptionInput,
} from '../src/build-event-description.js';
import type { QuoteApprovedDirective, SchedulingDirective } from '../src/types.js';

// ── fixtures ────────────────────────────────────────────────────────────

function makeDirective(
  overrides: Partial<QuoteApprovedDirective> = {},
): QuoteApprovedDirective {
  return {
    id: '01HQTESTBED',
    createdAt: '2026-05-30T12:00:00.000Z',
    source: 'qb_webhook',
    intent: 'quote_approved',
    eventClass: 'job',
    confidence: { score: 0.9, signals: ['qb_estimate_status_accepted'] },
    customerPhone: '+16175550123',
    pdPersonId: 9001,
    qbCustomerId: 'qb-1',
    qbEstimateId: 'qb-est-1',
    scopeSummary: 'John Smith — crack injection on rear wall',
    estimatedDurationHours: 4,
    durationPrediction: {
      point: 4,
      p25: 3,
      p75: 5,
      cv: 0.26,
      confidence: 'high',
      rationale: 'crack injection cluster n=37',
      similarCases: [],
      isMultiDay: false,
    },
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<BuildEventDescriptionInput> = {},
): BuildEventDescriptionInput {
  return {
    directive: makeDirective(),
    customer: {
      name: 'John Smith',
      address: '42 Beacon St, Boston MA 02108',
    },
    qbLineItems: [
      { description: 'Urethane crack injection - 8ft vertical crack rear wall' },
      { description: 'Carbon fiber staple add-on (qty 2)' },
    ],
    conversationHistory: [
      {
        direction: 'incoming',
        text: 'The basement entry is on the side, gate code is 1234, we have a friendly dog.',
        at: '2026-05-29T14:00:00.000Z',
      },
      {
        direction: 'outgoing',
        text: 'Thanks, will note it on the work order.',
        at: '2026-05-29T14:05:00.000Z',
      },
    ],
    photosUrl: 'https://photos.aac.example/job-1',
    accessNotes: 'Side entrance, friendly dog, gate code 1234.',
    ...overrides,
  };
}

function makeGemini(impl: (prompt: string) => Promise<string>): GeminiClient {
  return {
    generateContent: vi.fn(impl),
  } as unknown as GeminiClient;
}

const fixedNow = () => new Date('2026-05-30T12:00:00.000Z');

function makeDeps(gemini: GeminiClient): BuildEventDescriptionDeps {
  return { gemini, now: fixedNow };
}

// ── tests ────────────────────────────────────────────────────────────────

describe('buildEventDescription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Gemini output unchanged when all gates pass', async () => {
    const good = [
      'Scope:',
      '- Urethane crack injection on 8ft vertical crack rear wall',
      '',
      'Address:',
      '42 Beacon St, Boston MA 02108',
      '',
      'Access / site notes:',
      '- Side entrance, friendly dog, gate code 1234',
      '',
      'Photos:',
      'https://photos.aac.example/job-1',
      '',
      'Duration estimate:',
      '~4h (p25–p75: 3h–5h, high confidence)',
    ].join('\n');

    const gemini = makeGemini(async () => good);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.qualityFlags).toEqual([]);
    expect(result.attempts).toBe(1);
    expect(result.description).toContain('42 Beacon');
    expect(result.description).toContain('Urethane');
    expect(gemini.generateContent).toHaveBeenCalledTimes(1);
  });

  it('strips markdown fences from Gemini output', async () => {
    const fenced = '```\nScope:\n- Urethane crack injection rear wall\n\nAddress:\n42 Beacon St\n```';
    const gemini = makeGemini(async () => fenced);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.description.startsWith('```')).toBe(false);
    expect(result.description.endsWith('```')).toBe(false);
  });

  it('retries when address is missing then succeeds', async () => {
    const bad = 'Scope:\n- Urethane crack injection rear wall\n\nPhotos:\nhttps://photos.aac.example/job-1';
    const good = 'Scope:\n- Urethane crack injection rear wall\n\nAddress:\n42 Beacon St, Boston MA 02108';
    const fn = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    const gemini = { generateContent: fn } as unknown as GeminiClient;

    const result = await buildEventDescription(makeDeps(gemini), makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.qualityFlags).toEqual([]);
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
    // second call carries the retry note
    expect(fn.mock.calls[1][0]).toContain('PRIOR ATTEMPT FAILED');
    expect(fn.mock.calls[1][0]).toContain('address_missing');
  });

  it('flags line_item_missing when output ignores QB scope', async () => {
    const noLineItem = 'Scope:\n- Generic foundation work\n\nAddress:\n42 Beacon St';
    const gemini = makeGemini(async () => noLineItem);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.usedFallback).toBe(true);
    expect(result.qualityFlags).toContain('line_item_missing');
    expect(result.qualityFlags).toContain('fallback_used');
  });

  it('flags hallucinated facts when output invents a dollar figure', async () => {
    const haunted = 'Scope:\n- Urethane crack injection rear wall ($1,250 due on completion)\n\nAddress:\n42 Beacon St, Boston MA';
    const gemini = makeGemini(async () => haunted);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.qualityFlags).toContain('hallucinated_facts_suspected');
  });

  it('flags hallucinated facts when output invents a phone number', async () => {
    const haunted = 'Scope:\n- Urethane crack injection rear wall\n\nAddress:\n42 Beacon St\n\nContact: 617-555-9999';
    const gemini = makeGemini(async () => haunted);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.qualityFlags).toContain('hallucinated_facts_suspected');
  });

  it('skips address gate when no address on file', async () => {
    const noAddr = 'Scope:\n- Urethane crack injection rear wall\n\n(address not on file)';
    const gemini = makeGemini(async () => noAddr);
    const result = await buildEventDescription(
      makeDeps(gemini),
      makeInput({ customer: { name: 'John Smith', address: null } }),
    );
    expect(result.qualityFlags).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('skips line-item gate when QB line items are absent', async () => {
    const generic = 'Scope:\n- Customer reported water intrusion\n\nAddress:\n42 Beacon St';
    const gemini = makeGemini(async () => generic);
    const result = await buildEventDescription(
      makeDeps(gemini),
      makeInput({ qbLineItems: [] }),
    );
    expect(result.qualityFlags).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('falls back to template after exhausting retries', async () => {
    const empty = '';
    const gemini = makeGemini(async () => empty);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toBe(3); // 1 + 2 retries
    expect(result.description).toContain('42 Beacon');
    expect(result.description).toContain('Urethane');
    expect(result.description).toContain('Side entrance');
    expect(result.description).toContain('https://photos.aac.example/job-1');
    expect(result.qualityFlags).toContain('fallback_used');
    expect(gemini.generateContent).toHaveBeenCalledTimes(3);
  });

  it('falls back to template when Gemini throws', async () => {
    const gemini = makeGemini(async () => {
      throw new Error('network down');
    });
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    expect(result.usedFallback).toBe(true);
    expect(result.qualityFlags).toContain('gemini_unavailable');
    expect(result.qualityFlags).toContain('fallback_used');
  });

  it('clamps an over-length response and flags it on first try', async () => {
    const huge = 'a'.repeat(2000);
    const gemini = makeGemini(async () => huge);
    const result = await buildEventDescription(makeDeps(gemini), makeInput());
    // Sanitizer trims to MAX + ellipsis, so the gate-checked text is exactly MAX+1
    expect(result.description.length).toBeLessThanOrEqual(1201);
    expect(result.usedFallback).toBe(true);
  });

  it('produces a usable fallback when scope only comes from directive scopeSummary', async () => {
    const gemini = makeGemini(async () => '');
    const result = await buildEventDescription(
      makeDeps(gemini),
      makeInput({
        qbLineItems: [],
        accessNotes: undefined,
        photosUrl: undefined,
        conversationHistory: [],
      }),
    );
    expect(result.usedFallback).toBe(true);
    expect(result.description).toContain('John Smith — crack injection on rear wall');
    expect(result.description).toContain('42 Beacon');
  });

  it('handles assessment intent without QB line items', async () => {
    const assessmentDirective = {
      ...makeDirective(),
      intent: 'assessment_requested' as const,
      eventClass: 'assessment' as const,
      qbEstimateId: undefined,
      durationPrediction: null,
      estimatedDurationHours: null,
      scopeSummary: 'Wet basement NE corner',
    } as SchedulingDirective;

    const good = 'Scope:\n- Wet basement NE corner\n\nAddress:\n42 Beacon St, Boston MA 02108';
    const gemini = makeGemini(async () => good);

    const result = await buildEventDescription(
      makeDeps(gemini),
      makeInput({
        directive: assessmentDirective,
        qbLineItems: [],
      }),
    );

    expect(result.usedFallback).toBe(false);
    expect(result.qualityFlags).toEqual([]);
  });

  it('redacts no message text into the body (no fabrication test via prompt inspection)', async () => {
    const gemini = makeGemini(async () => 'Scope:\n- Urethane crack injection rear wall\n\nAddress:\n42 Beacon St');
    await buildEventDescription(makeDeps(gemini), makeInput());

    const prompt = (gemini.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('[customer] The basement entry');
    expect(prompt).toContain('[matt] Thanks, will note');
    expect(prompt).toContain('use ONLY these');
  });

  it('caps the conversation block to the last 20 messages', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      direction: 'incoming' as const,
      text: `message number ${i}`,
      at: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const gemini = makeGemini(async () => 'Scope:\n- Urethane crack injection rear wall\n\nAddress:\n42 Beacon St');
    await buildEventDescription(
      makeDeps(gemini),
      makeInput({ conversationHistory: many }),
    );
    const prompt = (gemini.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('message number 49');
    expect(prompt).toContain('message number 30');
    expect(prompt).not.toContain('message number 29');
  });
});
