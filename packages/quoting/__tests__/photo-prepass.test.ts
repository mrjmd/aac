import { describe, it, expect } from 'vitest';
import {
  areaSituationText,
  buildAreaAnalysisPrompt,
  formatPhotoContext,
  parseAreaAnalysis,
  type AreaAnalysis,
  type ExemplarLibraryEntry,
} from '../src/photo-prepass.js';
import { buildQuoteDraftPrompt } from '../src/draft-quote.js';

const thread = [
  { direction: 'incoming' as const, at: '2026-10-01T10:00:00Z', text: 'crack under my window' },
  { direction: 'outgoing' as const, at: '2026-10-01T10:05:00Z', text: 'can you send photos?' },
];

describe('buildAreaAnalysisPrompt', () => {
  it('includes thread, photo count, menu, and segmentation instruction', () => {
    const p = buildAreaAnalysisPrompt({ thread, photoCount: 3, itemNames: ['Crack Repair', 'Surface Seal'] });
    expect(p).toContain('3 photo(s)');
    expect(p).toContain('crack under my window');
    expect(p).toContain('Crack Repair | Surface Seal');
    expect(p).toContain('DISTINCT PHYSICAL AREAS');
    expect(p).toContain('never infer a repair from the mere presence of a structure');
  });
});

describe('parseAreaAnalysis', () => {
  it('parses a fenced response', () => {
    const raw = '```json\n' + JSON.stringify({
      photo_reads: [{ photo: 1, symptoms: ['crack'] }],
      areas: [{ area: 'A', photos: [1], description: 'wall crack', predicted_items: ['Crack Repair'] }],
      customer_asks: ['fix crack'],
    }) + '\n```';
    const a = parseAreaAnalysis(raw);
    expect(a?.areas).toHaveLength(1);
    expect(a?.customerAsks).toEqual(['fix crack']);
  });

  it('returns null on garbage or empty areas', () => {
    expect(parseAreaAnalysis('not json')).toBeNull();
    expect(parseAreaAnalysis('{"areas": []}')).toBeNull();
  });
});

describe('areaSituationText', () => {
  it('composes description + location + deduped symptoms (embed.ts parity)', () => {
    const text = areaSituationText(
      { area: 'A', photos: [1, 2], description: 'Bulkhead seam.', location: 'rear basement' },
      [
        { photo: 1, symptoms: ['water staining', 'efflorescence'] },
        { photo: 2, symptoms: ['water staining'] },
        { photo: 3, symptoms: ['unrelated'] },
      ],
    );
    expect(text).toBe('Bulkhead seam. Location: rear basement. Symptoms: water staining, efflorescence.');
  });
});

describe('formatPhotoContext', () => {
  const analysis: AreaAnalysis = {
    photoReads: [{ photo: 1, symptoms: ['water staining'] }],
    areas: [{ area: 'A', photos: [1], description: 'Bulkhead seam.', predicted_items: ['Bulkhead Injection'] }],
    customerAsks: ['bulkhead leak'],
  };
  const lib = (over: Partial<ExemplarLibraryEntry>): ExemplarLibraryEntry => ({
    id: '1:A',
    docNumber: '1502',
    txnDate: '2026-09-18',
    situation: 'Bulkhead seam with water.',
    quotedItems: [
      { item: 'Bulkhead Injection', unitPrice: 1900, qty: 1 },
      { item: 'Guarantee', unitPrice: 0, qty: 1 },
    ],
    embedModel: 'gemini-embedding-001',
    vector: [1],
    ...over,
  });

  it('renders areas with quoted exemplars, filtering non-scope items', () => {
    const ctx = formatPhotoContext({
      analysis,
      retrieved: [{ area: analysis.areas[0], exemplars: [{ item: lib({}), score: 0.91 }] }],
    });
    expect(ctx).toContain('AREA A (photos 1): Bulkhead seam. Symptoms: water staining.');
    expect(ctx).toContain('QUOTED: Bulkhead Injection ×1');
    expect(ctx).not.toContain('Guarantee');
    expect(ctx).toContain('sim 0.91');
    expect(ctx).toContain('account for EVERY area');
  });

  it('renders NOT QUOTED exemplars with the skip reason', () => {
    const ctx = formatPhotoContext({
      analysis,
      retrieved: [{
        area: analysis.areas[0],
        exemplars: [{ item: lib({ quotedItems: [], unquoted: 'dry settling crack' }), score: 0.8 }],
      }],
    });
    expect(ctx).toContain('NOT QUOTED (dry settling crack)');
  });
});

describe('buildQuoteDraftPrompt with photo context', () => {
  it('injects visual ruleset into system prompt and photo context into user prompt', () => {
    const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
      customerName: 'Erin',
      phone: '+16175550100',
      today: '2026-10-16',
      rulesetText: 'SECTION 0: anchor rules',
      itemNames: ['Crack Repair'],
      thread,
      photoCount: 2,
      photoContext: 'PHOTO AREA ANALYSIS: AREA A …',
      visualRulesetText: 'V.1 variant rules…',
    });
    expect(systemPrompt).toContain('VISUAL SCOPE RULESET');
    expect(systemPrompt).toContain('V.1 variant rules…');
    expect(userPrompt).toContain('PHOTO AREA ANALYSIS: AREA A …');
    expect(userPrompt.indexOf('PHOTO AREA ANALYSIS')).toBeLessThan(userPrompt.indexOf('THREAD:'));
  });

  it('is unchanged when the optional args are absent', () => {
    const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
      customerName: 'Erin',
      phone: '+16175550100',
      today: '2026-10-16',
      rulesetText: 'SECTION 0',
      itemNames: ['Crack Repair'],
      thread,
      photoCount: 0,
    });
    expect(systemPrompt).not.toContain('VISUAL SCOPE RULESET');
    expect(userPrompt).not.toContain('PHOTO AREA ANALYSIS');
  });
});
