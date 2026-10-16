import { describe, it, expect } from 'vitest';
import type { QBEstimate, QBItem } from '@aac/api-clients/quickbooks';
import {
  BOT_DRAFT_MARKER,
  BOT_DRAFT_TOP_LINE,
  assembleEstimateLines,
  buildDescriptionLibrary,
  buildDraftPrivateNote,
  buildQuoteDraftPrompt,
  countInjectionUnits,
  draftTotal,
  isBotDraft,
  parseQuoteDraftResponse,
  selectComparables,
  validateQuoteDraft,
  type QuoteDraft,
} from '../src/draft-quote.js';

const ITEM_NAMES = ['Crack Repair', 'Discount', 'Guarantee', 'Tie hole injections', 'Concrete floor crack'];

const ITEMS: QBItem[] = [
  { Id: '7', Name: 'Crack Repair' },
  { Id: '9', Name: 'Discount' },
  { Id: '12', Name: 'Guarantee' },
  { Id: '15', Name: 'Tie hole injections' },
  { Id: '18', Name: 'Concrete floor crack' },
];

function makeDraft(overrides?: Partial<QuoteDraft>): QuoteDraft {
  return {
    scopeSummary: 'Two vertical cracks in poured foundation.',
    lines: [{ item: 'Crack Repair', description: 'Urethane injection.', qty: 2, unitPrice: 1175 }],
    scopeAccounting: [
      { request: 'two cracks in basement wall', quotedItem: 'Crack Repair' },
    ],
    needsSiteVisit: false,
    reasoning: 'Section 0 rule 1-2.',
    openQuestions: [],
    confidence: 'high',
    ...overrides,
  };
}

function makeEstimate(overrides?: Partial<QBEstimate>): QBEstimate {
  return {
    Id: '500',
    SyncToken: '0',
    DocNumber: '1484',
    TxnDate: '2026-08-12',
    TxnStatus: 'Accepted',
    CustomerRef: { value: '42' },
    TotalAmt: 2350,
    Line: [
      {
        Amount: 2350,
        DetailType: 'SalesItemLineDetail',
        Description: 'Urethane injection of the vertical crack, full height.',
        SalesItemLineDetail: { ItemRef: { value: '7', name: 'Crack Repair' }, Qty: 2, UnitPrice: 1175 },
      },
      {
        Amount: 0,
        DetailType: 'SalesItemLineDetail',
        Description: 'Lifetime transferable guarantee…',
        SalesItemLineDetail: { ItemRef: { value: '12', name: 'Guarantee' }, Qty: 1, UnitPrice: 0 },
      },
    ],
    ...overrides,
  };
}

describe('parseQuoteDraftResponse', () => {
  it('parses a fenced JSON reply with snake_case fields', () => {
    const raw = '```json\n' + JSON.stringify({
      scope_summary: 'One crack.',
      lines: [{ item: 'Crack Repair', description: 'Inject it.', qty: 1, unit_price: 1175 }],
      needs_site_visit: false,
      reasoning: 'Rule 1.',
      open_questions: ['Is the wall painted?'],
      confidence: 'high',
    }) + '\n```';

    const draft = parseQuoteDraftResponse(raw);
    expect(draft).not.toBeNull();
    expect(draft!.lines).toEqual([{ item: 'Crack Repair', description: 'Inject it.', qty: 1, unitPrice: 1175 }]);
    expect(draft!.openQuestions).toEqual(['Is the wall painted?']);
    expect(draft!.confidence).toBe('high');
  });

  it('returns null on prose or empty lines', () => {
    expect(parseQuoteDraftResponse('I cannot draft this quote.')).toBeNull();
    expect(parseQuoteDraftResponse('{"scope_summary": "x", "lines": []}')).toBeNull();
  });

  it('parses scope_note and scope_accounting', () => {
    const draft = parseQuoteDraftResponse(JSON.stringify({
      lines: [{ item: 'Concrete Corner Rebuilding', scope_note: 'bulkhead corner crack', qty: 1, unit_price: 975 }],
      scope_accounting: [
        { request: 'cracks around bulkhead', quoted_item: 'Concrete Corner Rebuilding' },
        { request: 'breezeway step repair', quoted_item: null, reason: 'step has settled; not patchable', suggested_reply: 'The breezeway step has sunk and needs an on-site look before we can quote it.' },
        { request: '', reason: 'dropped — empty request' },
      ],
    }));
    expect(draft!.lines[0].scopeNote).toBe('bulkhead corner crack');
    expect(draft!.scopeAccounting).toHaveLength(2);
    expect(draft!.scopeAccounting[0].quotedItem).toBe('Concrete Corner Rebuilding');
    expect(draft!.scopeAccounting[1].quotedItem).toBeNull();
    expect(draft!.scopeAccounting[1].suggestedReply).toContain('on-site look');
  });

  it('drops malformed lines and defaults confidence to medium', () => {
    const draft = parseQuoteDraftResponse(JSON.stringify({
      lines: [
        { item: 'Crack Repair', qty: 1, unit_price: 1175 },
        { item: '', qty: 1, unit_price: 100 },
        { item: 'Discount', qty: 1, unit_price: 'oops' },
      ],
    }));
    expect(draft!.lines).toHaveLength(1);
    expect(draft!.confidence).toBe('medium');
  });
});

describe('countInjectionUnits', () => {
  it('counts qty-weighted wall injection and excludes floor/tie-hole work', () => {
    expect(countInjectionUnits([
      { item: 'Crack Repair', qty: 3, unitPrice: 1175 },
      { item: 'Tie hole injections', qty: 10, unitPrice: 75 },
      { item: 'Concrete floor crack', qty: 1, unitPrice: 675 },
    ])).toBe(3);
  });
});

describe('validateQuoteDraft', () => {
  it('passes a clean draft and canonicalizes item casing', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [{ item: 'crack repair', qty: 2, unitPrice: 1175 }],
    }), ITEM_NAMES);
    expect(v.ok).toBe(true);
    expect(v.draft.lines[0].item).toBe('Crack Repair');
  });

  it('hard-fails unknown items', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [{ item: 'French Drain Install', qty: 1, unitPrice: 5000 }],
    }), ITEM_NAMES);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('French Drain Install');
  });

  it('strips a discount on fewer than 3 injection units', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [
        { item: 'Crack Repair', qty: 2, unitPrice: 1175 },
        { item: 'Discount', qty: 1, unitPrice: -150 },
      ],
    }), ITEM_NAMES);
    expect(v.ok).toBe(true);
    expect(v.draft.lines.some((l) => l.item === 'Discount')).toBe(false);
    expect(v.warnings[0]).toContain('Stripped discount');
  });

  it('corrects a wrong discount amount to the -$75/unit formula', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [
        { item: 'Crack Repair', qty: 4, unitPrice: 1175 },
        { item: 'Discount', qty: 1, unitPrice: -400 },
      ],
    }), ITEM_NAMES);
    const discount = v.draft.lines.find((l) => l.item === 'Discount');
    expect(discount!.unitPrice).toBe(-300);
    expect(v.warnings[0]).toContain('Corrected discount');
  });

  it('keeps a formula-correct discount without warnings', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [
        { item: 'Crack Repair', qty: 3, unitPrice: 1175 },
        { item: 'Discount', qty: 1, unitPrice: -225 },
      ],
    }), ITEM_NAMES);
    expect(v.warnings).toEqual([]);
    expect(v.draft.lines.find((l) => l.item === 'Discount')!.unitPrice).toBe(-225);
  });

  it('flags missing, dangling, and reason-less scope accounting', () => {
    const noAccounting = validateQuoteDraft(makeDraft({ scopeAccounting: [] }), ITEM_NAMES);
    expect(noAccounting.warnings.some((w) => w.includes('no scope accounting'))).toBe(true);

    const dangling = validateQuoteDraft(makeDraft({
      scopeAccounting: [
        { request: 'bulkhead cracks', quotedItem: 'Bulkhead Injection' },
        { request: 'sunken step', quotedItem: null },
      ],
    }), ITEM_NAMES);
    expect(dangling.warnings.some((w) => w.includes('"Bulkhead Injection"') && w.includes('no such line'))).toBe(true);
    expect(dangling.warnings.some((w) => w.includes('"sunken step"') && w.includes('no reason'))).toBe(true);
  });

  it('drops model-authored guarantee lines and fails drafts with no sales lines', () => {
    const v = validateQuoteDraft(makeDraft({
      lines: [{ item: 'Guarantee', qty: 1, unitPrice: 0 }],
    }), ITEM_NAMES);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('no sales lines');
  });
});

describe('assembleEstimateLines', () => {
  it('puts the bot marker first, fills descriptions from the library, appends Guarantee', () => {
    const library = new Map([
      ['Crack Repair', 'Canonical crack description.'],
      ['Guarantee', 'Canonical guarantee text.'],
    ]);
    const lines = assembleEstimateLines({
      draft: makeDraft({
        lines: [{ item: 'Crack Repair', qty: 2, unitPrice: 1175 }],
      }),
      items: ITEMS,
      descriptionLibrary: library,
    });

    expect(lines[0]).toEqual({
      DetailType: 'DescriptionOnly',
      Description: BOT_DRAFT_TOP_LINE,
      DescriptionLineDetail: {},
    });
    expect(lines[1].Amount).toBe(2350);
    expect(lines[1].Description).toBe('Canonical crack description.');
    expect(lines[1].SalesItemLineDetail!.ItemRef).toEqual({ value: '7', name: 'Crack Repair' });
    const last = lines[lines.length - 1];
    expect(last.SalesItemLineDetail!.ItemRef!.name).toBe('Guarantee');
    expect(last.Amount).toBe(0);
  });

  it('uses the QBO item template verbatim over library and model text', () => {
    const itemsWithTemplates = ITEMS.map((i) =>
      i.Name === 'Crack Repair' ? { ...i, Description: 'Standard QBO template.' } : i,
    );
    const lines = assembleEstimateLines({
      draft: makeDraft(), // model supplied "Urethane injection."
      items: itemsWithTemplates,
      descriptionLibrary: new Map([['Crack Repair', 'Library wording.']]),
    });
    expect(lines[1].Description).toBe('Standard QBO template.');
  });

  it('prepends the bracketed scope note ahead of the template', () => {
    const itemsWithTemplates = ITEMS.map((i) =>
      i.Name === 'Crack Repair' ? { ...i, Description: 'Standard QBO template.' } : i,
    );
    const lines = assembleEstimateLines({
      draft: makeDraft({
        lines: [{ item: 'Crack Repair', scopeNote: 'bulkhead corner crack', qty: 1, unitPrice: 1175 }],
      }),
      items: itemsWithTemplates,
      descriptionLibrary: new Map(),
    });
    expect(lines[1].Description).toBe('[bulkhead corner crack]\n\nStandard QBO template.');
  });

  it('falls back library → model text only when no template exists', () => {
    const withLibrary = assembleEstimateLines({
      draft: makeDraft(),
      items: ITEMS,
      descriptionLibrary: new Map([['Crack Repair', 'Library wording.']]),
    });
    expect(withLibrary[1].Description).toBe('Library wording.');

    const modelOnly = assembleEstimateLines({
      draft: makeDraft(),
      items: ITEMS,
      descriptionLibrary: new Map(),
    });
    expect(modelOnly[1].Description).toBe('Urethane injection.');
  });
});

describe('isBotDraft + buildDescriptionLibrary', () => {
  it('detects bot drafts by PrivateNote or top line', () => {
    expect(isBotDraft(makeEstimate({ PrivateNote: `${BOT_DRAFT_MARKER} — drafter v1` }))).toBe(true);
    expect(isBotDraft(makeEstimate({
      Line: [{ Amount: 0, DetailType: 'DescriptionOnly', Description: BOT_DRAFT_TOP_LINE }],
    }))).toBe(true);
    expect(isBotDraft(makeEstimate())).toBe(false);
  });

  it('builds the library from the newest real estimate and skips bot drafts', () => {
    const bot = makeEstimate({ PrivateNote: BOT_DRAFT_MARKER });
    bot.Line[0].Description = 'Bot-authored description.';
    const lib = buildDescriptionLibrary([bot, makeEstimate()]);
    expect(lib.get('Crack Repair')).toBe('Urethane injection of the vertical crack, full height.');
  });
});

describe('selectComparables', () => {
  it('returns estimates sharing an item, skipping bot drafts, capped at max', () => {
    const comps = selectComparables(
      [
        makeEstimate({ PrivateNote: BOT_DRAFT_MARKER, DocNumber: '1600' }),
        makeEstimate({ DocNumber: '1500' }),
        makeEstimate({ DocNumber: '1490' }),
        makeEstimate({
          DocNumber: '1480',
          Line: [{
            Amount: 675,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { value: '18', name: 'Concrete floor crack' }, Qty: 1, UnitPrice: 675 },
          }],
        }),
      ],
      makeDraft(),
      2,
    );
    expect(comps.map((c) => c.docNumber)).toEqual(['1500', '1490']);
    expect(comps[0].itemSummary).toBe('Crack Repair ×2 @$1175');
  });
});

describe('buildDraftPrivateNote + draftTotal', () => {
  it('leads with the marker and includes totals, comparables, and corrections', () => {
    const draft = makeDraft({
      lines: [
        { item: 'Crack Repair', qty: 3, unitPrice: 1175 },
        { item: 'Discount', qty: 1, unitPrice: -225 },
      ],
      needsSiteVisit: true,
      openQuestions: ['Confirm crack count from photos'],
      scopeAccounting: [
        { request: 'three basement cracks', quotedItem: 'Crack Repair' },
        {
          request: 'breezeway step repair',
          quotedItem: null,
          reason: 'settled step, scope unclear',
          suggestedReply: 'The breezeway step looks settled — I want to see it in person before quoting.',
        },
      ],
    });
    expect(draftTotal(draft)).toBe(3300);

    const note = buildDraftPrivateNote({
      draft,
      warnings: ['Corrected discount to formula: -$225'],
      comparables: selectComparables([makeEstimate()], draft),
      generatedAt: '2026-10-16',
    });
    expect(note.startsWith(BOT_DRAFT_MARKER)).toBe(true);
    expect(note).toContain('Total: $3300');
    expect(note).toContain('SITE VISIT RECOMMENDED');
    expect(note).toContain('#1484 2026-08-12 Accepted $2350');
    expect(note).toContain('Scope accounting');
    expect(note).toContain('- "three basement cracks" → Crack Repair');
    expect(note).toContain('- "breezeway step repair" → EXCLUDED: settled step, scope unclear | Say: "The breezeway step looks settled');
    expect(note).toContain('Confirm crack count');
    expect(note).toContain('Corrected discount');
  });
});

describe('buildQuoteDraftPrompt', () => {
  it('embeds the ruleset, item menu, thread digest, and photo count', () => {
    const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
      customerName: 'Jane Doe',
      phone: '+16175550100',
      today: '2026-10-16',
      rulesetText: 'SECTION 0 — rules here',
      itemNames: ITEM_NAMES,
      thread: [
        { direction: 'incoming', at: '2026-10-14T09:00:00Z', text: 'Got a leaking crack' },
        { direction: 'outgoing', at: '2026-10-14T09:05:00Z', text: 'Can you send photos?' },
      ],
      photoCount: 2,
    });
    expect(systemPrompt).toContain('SECTION 0 — rules here');
    expect(systemPrompt).toContain('Crack Repair | Discount | Guarantee');
    expect(systemPrompt).toContain('NEVER add a cash/check discount');
    expect(userPrompt).toContain('Jane Doe (+16175550100)');
    expect(userPrompt).toContain('IN 2026-10-14T09:00: Got a leaking crack');
    expect(userPrompt).toContain('OUT 2026-10-14T09:05: Can you send photos?');
    expect(userPrompt).toContain('PHOTOS: 2 attached');
  });
});
