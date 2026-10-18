import { describe, it, expect } from 'vitest';
import {
  nameTokens,
  matchEventsToCustomer,
  inDebriefWindow,
  buildFieldExtractionPrompt,
  parseFieldExtraction,
  formatFieldContext,
} from '../src/field-context';

const DAY = 86_400_000;

describe('nameTokens', () => {
  it('splits last vs first and drops short words', () => {
    expect(nameTokens('Mark T Mitchell')).toEqual({ last: ['mitchell'], first: ['mark'] });
  });
  it('single usable word goes to last', () => {
    expect(nameTokens('Paul')).toEqual({ last: ['paul'], first: [] });
  });
});

describe('matchEventsToCustomer', () => {
  const events = [
    { id: 'e1', summary: 'Shannon Fullerton', colorId: '3', startMs: 1000 },
    { id: 'e2', summary: 'Steven Hajko', colorId: '10', startMs: 2000 },
    { id: 'e3', summary: 'Shannon', colorId: '3', startMs: 3000 },
    { id: 'e4', summary: 'Shannon', colorId: '10', startMs: 4000 },
  ];
  it('last-name hit matches any event; first-name only matches assessments', () => {
    const m = matchEventsToCustomer(events, 'Shannon Fullerton');
    expect(m.map((e) => e.id)).toEqual(['e1', 'e3']); // e4 is first-name on a non-assessment
  });
  it('does not false-positive on shared first names', () => {
    expect(matchEventsToCustomer(events, 'Steven Kononchik').map((e) => e.id)).toEqual([]);
  });
  it('flags assessments', () => {
    expect(matchEventsToCustomer(events, 'Shannon Fullerton')[0].isAssessment).toBe(true);
  });
});

describe('inDebriefWindow', () => {
  const visit = 100 * DAY;
  it('covers same day through +2 days', () => {
    expect(inDebriefWindow(visit + 1 * DAY, visit)).toBe(true);
    expect(inDebriefWindow(visit + 3 * DAY, visit)).toBe(false);
    expect(inDebriefWindow(visit - DAY, visit)).toBe(false);
  });
});

describe('buildFieldExtractionPrompt', () => {
  it('is label-blind and carries the evidence', () => {
    const p = buildFieldExtractionPrompt({
      customerName: 'Jeff Jocks',
      evidence: {
        events: [{ id: 'e', summary: 'Jocks assessment', startMs: Date.UTC(2026, 9, 1), colorId: '3', isAssessment: true }],
        texts: [{ at: '2026-10-01T15:00:00Z', fromOwner: false, text: 'back corner is damp' }],
        callTranscripts: [{ at: '2026-10-01T18:00:00Z', durationMin: 7, dialogue: 'MIKE: one main damp corner' }],
      },
    });
    expect(p).toContain('Jeff Jocks');
    expect(p).toContain('ASSESSMENT');
    expect(p).toContain('back corner is damp');
    expect(p).not.toMatch(/QUOTE LINES/i);
  });
});

describe('parseFieldExtraction', () => {
  it('parses a relevant extraction', () => {
    expect(parseFieldExtraction('{"relevant": true, "findings": "Two cracks behind the heater.", "quotes": ["tight access"]}'))
      .toEqual({ relevant: true, findings: 'Two cracks behind the heater.', quotes: ['tight access'] });
  });
  it('normalizes relevant-but-empty findings to not-relevant', () => {
    expect(parseFieldExtraction('{"relevant": true, "findings": "None", "quotes": []}'))
      .toEqual({ relevant: false, findings: null, quotes: [] });
  });
  it('returns null on garbage', () => {
    expect(parseFieldExtraction('no json here')).toBeNull();
  });
});

describe('formatFieldContext', () => {
  it('renders findings + tech photo note', () => {
    const s = formatFieldContext({
      extraction: { relevant: true, findings: 'Damp back corner.', quotes: ['slow seep'] },
      techPhotoCount: 2,
      customerPhotoCount: 3,
    });
    expect(s).toContain('FIELD CONTEXT');
    expect(s).toContain('Damp back corner.');
    expect(s).toContain('"slow seep"');
    expect(s).toContain('last 2 image(s)');
  });
  it('empty when nothing applies', () => {
    expect(formatFieldContext({ extraction: null, techPhotoCount: 0, customerPhotoCount: 3 })).toBe('');
  });
});
