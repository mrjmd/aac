import { describe, it, expect, vi } from 'vitest';
import type { QuickBooksClient, QBEstimate } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import {
  MemoryDraftState,
  isDone,
  gateFollowup,
  gateIntake,
  gateCtRouting,
  followupFallback,
  ctRoutingFallback,
  buildLucHandoff,
  pickExemplars,
  isFollowupCandidate,
  processFollowupEstimate,
  processIntakePhone,
  type DraftDeps,
} from '../src/index.js';

const NOW = new Date('2026-10-21T15:00:00Z').getTime();

function makeEstimate(overrides: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: 'est-1',
    SyncToken: '0',
    DocNumber: '1570',
    TxnStatus: 'Pending',
    EmailStatus: 'EmailSent',
    CustomerRef: { value: 'cust-1', name: 'Jane Doe' },
    DeliveryInfo: { DeliveryType: 'Email', DeliveryTime: new Date(NOW - 60_000).toISOString() },
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: 1175,
        Description: 'Vertical crack, poured foundation',
        SalesItemLineDetail: { ItemRef: { value: '1', name: 'Crack Repair' } },
      },
    ],
    TotalAmt: 1175,
    ...overrides,
  } as unknown as QBEstimate;
}

function makeDeps(overrides: {
  qb?: Partial<Record<string, unknown>>;
  quo?: Partial<Record<string, unknown>>;
  gemini?: Partial<Record<string, unknown>>;
} = {}): { deps: DraftDeps; state: MemoryDraftState; mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const state = new MemoryDraftState(() => NOW);
  const mocks = {
    getCustomer: vi.fn().mockResolvedValue({
      Id: 'cust-1',
      GivenName: 'Jane',
      DisplayName: 'Jane Doe',
      PrimaryPhone: { FreeFormNumber: '(978) 555-0101' },
    }),
    getEstimate: vi.fn(),
    query: vi.fn(),
    listMessages: vi.fn().mockResolvedValue({ data: [] }),
    listCalls: vi.fn().mockResolvedValue({ data: [] }),
    getCallVoicemail: vi.fn().mockResolvedValue(null),
    listConversations: vi.fn().mockResolvedValue({ data: [] }),
    findContactByPhone: vi.fn().mockResolvedValue({ id: 'quo-contact-1' }),
    createContactNote: vi.fn().mockResolvedValue({ id: 'note-1' }),
    generateContent: vi.fn().mockResolvedValue(
      'Hey Jane, I just sent that quote over to your email. It covers the vertical crack repair in the basement. Let me know if you have any questions once you review it — once the quote is approved we can get you on the schedule. Thanks!',
    ),
  };
  const deps: DraftDeps = {
    qb: { getCustomer: mocks.getCustomer, getEstimate: mocks.getEstimate, query: mocks.query, ...overrides.qb } as unknown as QuickBooksClient,
    quo: {
      listMessages: mocks.listMessages,
      listCalls: mocks.listCalls,
      getCallVoicemail: mocks.getCallVoicemail,
      listConversations: mocks.listConversations,
      findContactByPhone: mocks.findContactByPhone,
      createContactNote: mocks.createContactNote,
      ...overrides.quo,
    } as unknown as QuoClient,
    gemini: { generateContent: mocks.generateContent, ...overrides.gemini } as unknown as GeminiClient,
    state,
    now: () => NOW,
  };
  return { deps, state, mocks };
}

describe('state claims', () => {
  it('appendRecord stamps `at` so triage can age drafts and sent-check them', async () => {
    const state = new MemoryDraftState(() => NOW);
    await state.appendRecord({ type: 'followup', outcome: 'drafted' });
    expect(state.records[0]).toMatchObject({
      at: new Date(NOW).toISOString(),
      type: 'followup',
      outcome: 'drafted',
    });
  });

  it('isDone: final markers are done, fresh pending claims are done, stale pending claims are not', () => {
    expect(isDone(null, NOW)).toBe(false);
    expect(isDone('2026-10-21T14:00:00Z', NOW)).toBe(true);
    expect(isDone('skipped:matt-replied', NOW)).toBe(true);
    expect(isDone(`pending:${new Date(NOW - 5 * 60_000).toISOString()}`, NOW)).toBe(true);
    expect(isDone(`pending:${new Date(NOW - 30 * 60_000).toISOString()}`, NOW)).toBe(false);
  });

  it('claim is exclusive until released', async () => {
    const state = new MemoryDraftState(() => NOW);
    expect(await state.claimFollowup('e1')).toBe(true);
    expect(await state.claimFollowup('e1')).toBe(false);
    await state.releaseFollowup('e1');
    expect(await state.claimFollowup('e1')).toBe(true);
  });
});

describe('gates and fallbacks', () => {
  it('gateFollowup rejects prices and missing elements', () => {
    expect(gateFollowup('too short')).toContain('length');
    expect(gateFollowup(`${'x'.repeat(100)} the quote is in your email, $1,175 total, review and send questions`)).toBe('contains a price');
    expect(gateFollowup(followupFallback('Jane', 'crack repair'))).toBeNull();
    expect(gateFollowup(followupFallback(null, 'crack repair'))).toBeNull();
  });

  it('gateIntake catches photo-thanks without photos and lead-time claims', () => {
    const base = 'Thanks for reaching out! We can help with that. Could you send your full name, address, and an email for the quote? -- Matt at Attack A Crack';
    expect(gateIntake(base, 'crack in basement', 0)).toBeNull();
    expect(gateIntake(`Thanks for sending photos! ${base}`, 'crack in basement', 0)).toBe('thanks for photos without photos');
    expect(gateIntake(`${base} We are booking about a month out.`, 'crack', 1)).toBe('lead-time claim');
  });

  it('gateCtRouting demands Luc + MA office + forward-style, and the fallback passes', () => {
    expect(gateCtRouting(ctRoutingFallback('Sam'))).toBeNull();
    expect(gateCtRouting(ctRoutingFallback(null))).toBeNull();
    expect(gateCtRouting('Hi, wrong office, call someone else. This message is long enough to pass the length gate easily.')).toBe("missing Luc's number");
  });

  it('buildLucHandoff formats bare lines then quoted message', () => {
    const txt = buildLucHandoff({
      phone: '+18605550111',
      extracted: { name: 'Sam Smith', address: '12 Main St, Enfield CT', email: 'sam@x.com' },
      customerText: 'Crack in my basement wall',
      mediaUrls: ['https://m/1.jpg'],
    });
    expect(txt).toContain('Sam Smith\n12 Main St, Enfield CT\nsam@x.com\n+18605550111');
    expect(txt).toContain('Here\'s what Sam sent: "Crack in my basement wall"');
    expect(txt).toContain('1 photo(s) in the thread');
  });

  it('pickExemplars rotates deterministically and handles empty', () => {
    const all = [1, 2, 3, 4, 5];
    expect(pickExemplars(all, 3, 0)).toEqual([1, 3, 5]);
    expect(pickExemplars([], 3, 0)).toEqual([]);
  });
});

describe('processFollowupEstimate', () => {
  it('drafts and posts a note for an emailed pending estimate', async () => {
    const { deps, state, mocks } = makeDeps();
    const record = await processFollowupEstimate(deps, makeEstimate());
    expect(record?.outcome).toBe('drafted');
    expect(mocks.createContactNote).toHaveBeenCalledTimes(1);
    const note = mocks.createContactNote.mock.calls[0][1] as string;
    expect(note).toContain('POST-QUOTE FOLLOW-UP');
    expect(note).toContain('Quote #1570');
    expect(await state.getFollowup('est-1')).toBe(new Date(NOW).toISOString());
  });

  it('skips non-candidates and already-done estimates', async () => {
    const { deps, state, mocks } = makeDeps();
    expect(await processFollowupEstimate(deps, makeEstimate({ TxnStatus: 'Accepted' } as Partial<QBEstimate>))).toBeNull();
    expect(await processFollowupEstimate(deps, makeEstimate({ EmailStatus: 'NotSet' } as Partial<QBEstimate>))).toBeNull();
    await state.setFollowup('est-1', '2026-10-21T10:00:00Z');
    expect(await processFollowupEstimate(deps, makeEstimate())).toBeNull();
    expect(mocks.createContactNote).not.toHaveBeenCalled();
  });

  it('stays silent when Matt already texted after the email went out', async () => {
    const { deps, state, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({
      data: [{ direction: 'outgoing', text: 'Just sent your quote, talk soon!', createdAt: new Date(NOW - 10_000).toISOString() }],
    });
    const record = await processFollowupEstimate(deps, makeEstimate());
    expect(record?.outcome).toBe('matt-already-texted');
    expect(mocks.createContactNote).not.toHaveBeenCalled();
    expect(await state.getFollowup('est-1')).toBe('skipped:matt-already-texted');
  });

  it('ignores automated outbound when checking whether Matt replied', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({
      data: [{ direction: 'outgoing', text: 'Apologies for missing your call. Please send us a text with your name.', createdAt: new Date(NOW - 10_000).toISOString() }],
    });
    const record = await processFollowupEstimate(deps, makeEstimate());
    expect(record?.outcome).toBe('drafted');
  });

  it('uses the fallback skeleton when generation fails the gate', async () => {
    const { deps, mocks } = makeDeps();
    mocks.generateContent.mockResolvedValue('way too short');
    const record = await processFollowupEstimate(deps, makeEstimate());
    expect(record?.outcome).toBe('drafted');
    expect(record?.fallback).toContain('length');
    expect(mocks.createContactNote.mock.calls[0][1]).toContain('I just sent that quote over');
  });

  it('releases the claim when no Quo contact exists yet so a later pass retries', async () => {
    const { deps, state, mocks } = makeDeps();
    mocks.findContactByPhone.mockResolvedValue(null);
    const record = await processFollowupEstimate(deps, makeEstimate());
    expect(record?.outcome).toBe('no-quo-contact');
    expect(await state.getFollowup('est-1')).toBeNull();
  });

  it('skips estimates older than 12h on first activation', async () => {
    const { deps, state } = makeDeps();
    const stale = makeEstimate();
    (stale.DeliveryInfo as { DeliveryTime: string }).DeliveryTime = new Date(NOW - 20 * 3_600_000).toISOString();
    const record = await processFollowupEstimate(deps, stale, { firstRun: true });
    expect(record).toBeNull();
    expect(await state.getFollowup('est-1')).toBe('skipped:stale-at-first-run');
  });
});

describe('processIntakePhone', () => {
  const inboundMsg = (ageMin: number, text: string, media = 0) => ({
    direction: 'incoming',
    text,
    media: Array.from({ length: media }, (_, i) => ({ url: `https://m/${i}.jpg` })),
    createdAt: new Date(NOW - ageMin * 60_000).toISOString(),
  });
  const intakeJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      classification: 'lead',
      propertyState: 'MA',
      provided: { name: false, address: false, email: false },
      extracted: { name: null, address: null, email: null },
      draft:
        'Hello, thanks for reaching out! We can definitely help with that crack. Could you send your full name, the address of the property, and an email address for the quote? -- Matt at Attack A Crack',
      ...over,
    });

  it('drafts the intake ask for a fresh unanswered lead', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(20, 'I have a crack in my basement wall')] });
    mocks.generateContent.mockResolvedValue(intakeJson());
    const outcome = await processIntakePhone(deps, '+19785550123');
    expect(outcome.kind).toBe('drafted');
    expect(mocks.createContactNote.mock.calls[0][1]).toContain('FIRST-TOUCH INTAKE');
  });

  it('skips internal lines, replied threads, and spam', async () => {
    const { deps, mocks } = makeDeps();
    expect((await processIntakePhone(deps, '+16177660151')).reason).toBe('not-a-customer-line');

    mocks.listMessages.mockResolvedValue({
      data: [inboundMsg(20, 'crack in wall'), { direction: 'outgoing', text: 'On it, thanks!', createdAt: new Date(NOW).toISOString() }],
    });
    expect((await processIntakePhone(deps, '+19785550124')).reason).toBe('matt-replied');

    mocks.listMessages.mockResolvedValue({
      data: [inboundMsg(20, 'We send homeowners in your area ready for foundation repair, pay per booked estimate!')],
    });
    expect((await processIntakePhone(deps, '+19785550125')).reason).toBe('spam-regex');
  });

  it('waits out the preemption window, then ages out stale inquiries', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(5, 'crack in my foundation')] });
    expect((await processIntakePhone(deps, '+19785550126')).kind).toBe('retry-later');

    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(60 * 72, 'crack in my foundation')] });
    expect((await processIntakePhone(deps, '+19785550126')).reason).toBe('inquiry-too-old');
  });

  it('voice-call engagement guard: Matt dialed them → not a first touch', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(20, 'photos of the crack', 3)] });
    mocks.listCalls.mockResolvedValue({
      data: [{ direction: 'outgoing', status: 'completed', duration: 120, createdAt: new Date(NOW - 30 * 60_000).toISOString(), id: 'c1' }],
    });
    expect((await processIntakePhone(deps, '+19785550127')).reason).toBe('matt-called-them');
  });

  it('voicemail-only caller: drafts from the transcript', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [] });
    mocks.listCalls.mockResolvedValue({
      data: [{ direction: 'incoming', status: 'no-answer', duration: 0, createdAt: new Date(NOW - 20 * 60_000).toISOString(), id: 'c2' }],
    });
    mocks.getCallVoicemail.mockResolvedValue({ status: 'completed', transcript: 'Hi, I have a crack in my foundation, call me back.' });
    mocks.generateContent.mockResolvedValue(intakeJson());
    const outcome = await processIntakePhone(deps, '+19785550128');
    expect(outcome.kind).toBe('drafted');
  });

  it('CT property → one note with routing reply + Luc handoff', async () => {
    const { deps, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(20, 'Crack in my basement in Enfield CT. Sam Smith, sam@x.com', 2)] });
    mocks.generateContent
      .mockResolvedValueOnce(intakeJson({ propertyState: 'CT', draft: '', extracted: { name: 'Sam Smith', address: 'Enfield CT', email: 'sam@x.com' } }))
      .mockResolvedValueOnce('generation fails the gate on purpose');
    const outcome = await processIntakePhone(deps, '+18605550129');
    expect(outcome.kind).toBe('drafted');
    const note = mocks.createContactNote.mock.calls[0][1] as string;
    expect(note).toContain('CT→LUC ROUTING');
    expect(note).toContain('HANDOFF TO LUC');
    expect(note).toContain('Sam Smith');
    expect(note).toContain('(CT area code)');
  });

  it('gives up on a missing Quo contact only after MAX_NOTE_ATTEMPTS', async () => {
    const { deps, state, mocks } = makeDeps();
    mocks.listMessages.mockResolvedValue({ data: [inboundMsg(20, 'crack in basement')] });
    mocks.generateContent.mockResolvedValue(intakeJson());
    mocks.findContactByPhone.mockResolvedValue(null);
    for (let i = 0; i < 7; i++) {
      expect((await processIntakePhone(deps, '+19785550130')).kind).toBe('retry-later');
    }
    expect((await processIntakePhone(deps, '+19785550130')).reason).toBe('no-quo-contact-gave-up');
    expect(await state.getIntake('+19785550130')).toBe('skipped:no-quo-contact');
  });

  it('isFollowupCandidate requires EmailSent + Pending', () => {
    expect(isFollowupCandidate(makeEstimate())).toBe(true);
    expect(isFollowupCandidate(makeEstimate({ TxnStatus: 'Accepted' } as Partial<QBEstimate>))).toBe(false);
  });
});
