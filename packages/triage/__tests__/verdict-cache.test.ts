/**
 * The per-thread L1/L2 verdict cache (plan decision 2): a verdict is reused
 * while its thread, the prompt template, the model and the generation
 * params are unchanged; fresh verdicts are written as they return; errors
 * and parse failures are never cached; calendar/estimate-dependent
 * verdicts are always re-asked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MemoryTriageStore,
  VERDICT_CACHE_SALT,
  VERDICT_PROMPT_TEMPLATE,
  analyze,
  verdictCacheSalt,
  verdictHash,
  type AnalyzeDeps,
  type EmailThreadSnapshot,
  type Snapshot,
  type ThreadSnapshot,
  type TriageGemini,
} from '../src/index.js';

const NOW = new Date('2026-11-05T15:00:00Z').getTime();
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const PHONE = '+16175550100';

const UNRESOLVED = JSON.stringify({
  needs_action: true,
  category: 'unresolved',
  customer_name: 'Pat Doe',
  title: 'Awaiting reply',
  summary: 'Asked about a bulkhead crack.',
  evidence: 'Can you look at my bulkhead?',
  suggested_action: 'Reply',
  urgency: 'yellow',
  confidence: 'high',
  due_at: null,
});

function thread(messages: ThreadSnapshot['messages']): ThreadSnapshot {
  return { phone: PHONE, conversationId: 'c1', lastActivityAt: messages[messages.length - 1].at, messages, calls: [] };
}

const firstMessage: ThreadSnapshot['messages'][number] = {
  direction: 'incoming',
  at: iso(NOW - 2 * DAY),
  text: 'Can you look at my bulkhead?',
} as ThreadSnapshot['messages'][number];

function snapshot(threads: ThreadSnapshot[] = [thread([firstMessage])], emails: EmailThreadSnapshot[] = []): Snapshot {
  return {
    generatedAt: iso(NOW - 60_000),
    windows: {
      calendarFrom: iso(NOW - 60 * DAY),
      calendarTo: iso(NOW + 60 * DAY),
      qboSince: iso(NOW - 180 * DAY).slice(0, 10),
      quoActiveSince: iso(NOW - 21 * DAY),
    },
    calendar: [],
    estimates: [],
    invoices: [],
    customers: [],
    completions: {},
    scheduling: { pending: [], review: [] },
    todos: [],
    worker: {
      messageDraftRecords: [],
      quoteDrafterRunlog: [],
      scopeFlags: [],
      messageDraftsHeartbeat: iso(NOW - 120_000),
      quoteDrafterHeartbeat: iso(NOW - 120_000),
      quoteDrafterModeOverride: null,
    },
    threads,
    emails,
    stats: {},
  };
}

function gemini(answer: string | Error = UNRESOLVED) {
  const generateContent = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const client = { extractEntities: vi.fn().mockResolvedValue({ firstName: 'Canary' }), generateContent } as unknown as TriageGemini;
  return { client, generateContent };
}

function deps(store: MemoryTriageStore, client: TriageGemini, log: (m: string) => void = () => {}): AnalyzeDeps {
  return {
    geminiApiKey: 'test',
    createGemini: () => client,
    store,
    quoPhoneNumber: '+16176681677',
    technicianEmails: [],
    now: () => NOW,
    log,
  };
}

const l1 = (findings: Array<{ source?: string }>) => findings.filter((f) => f.source === 'L1');

describe('verdict cache', () => {
  it('a miss asks Gemini and writes the verdict under triage:verdict:sms:{phone}:{hash}', async () => {
    const store = new MemoryTriageStore();
    const g = gemini();
    const out = await analyze(snapshot(), deps(store, g.client));
    expect(g.generateContent).toHaveBeenCalledTimes(1);
    expect(l1(out.findings)).toHaveLength(1);
    const prompt = (g.generateContent.mock.calls[0] as unknown as [string])[0];
    const key = `triage:verdict:sms:${PHONE}:${verdictHash(prompt, firstMessage.at)}`;
    expect([...store.verdicts.keys()]).toEqual([key]);
    expect(store.verdicts.get(key)).toMatchObject({ verdict: { category: 'unresolved' }, at: iso(NOW) });
    expect(out.stats.llmCacheHits).toBe(0);
  });

  it('a hit reuses the verdict without Gemini and yields the same findings', async () => {
    const store = new MemoryTriageStore();
    const cold = await analyze(snapshot(), deps(store, gemini().client));
    const g = gemini('{"needs_action": false, "category": "none"}'); // would change the result if asked
    const warm = await analyze(snapshot(), deps(store, g.client));
    expect(g.generateContent).not.toHaveBeenCalled();
    expect(warm.findings).toEqual(cold.findings);
    expect(warm.stats.llmCacheHits).toBe(1);
  });

  it('a new message on the thread misses', async () => {
    const store = new MemoryTriageStore();
    await analyze(snapshot(), deps(store, gemini().client));
    const reply = { direction: 'outgoing', at: iso(NOW - DAY), text: 'Sure, sending times.' } as ThreadSnapshot['messages'][number];
    const g = gemini('{"needs_action": false, "category": "none"}');
    const out = await analyze(snapshot([thread([firstMessage, reply])]), deps(store, g.client));
    expect(g.generateContent).toHaveBeenCalledTimes(1);
    expect(l1(out.findings)).toHaveLength(0);
    expect(store.verdicts.size).toBe(2);
  });

  it('a prompt template change misses (the salt covers the template, model and params)', async () => {
    const parts = { version: 'triage-verdict-v1', model: 'gemini-flash-latest', gen: { maxOutputTokens: 8192, temperature: 0 } };
    expect(verdictCacheSalt({ ...parts, template: VERDICT_PROMPT_TEMPLATE })).toBe(VERDICT_CACHE_SALT);
    const edited = verdictCacheSalt({ ...parts, template: `${VERDICT_PROMPT_TEMPLATE}\nBe terse.` });
    const otherModel = verdictCacheSalt({ ...parts, model: 'gemini-3-flash', template: VERDICT_PROMPT_TEMPLATE });
    expect(new Set([VERDICT_CACHE_SALT, edited, otherModel]).size).toBe(3);

    // A verdict cached under the edited template's hash is not reused.
    const store = new MemoryTriageStore();
    const probe = gemini();
    await analyze(snapshot(), deps(new MemoryTriageStore(), probe.client));
    const prompt = (probe.generateContent.mock.calls[0] as unknown as [string])[0];
    await store.setVerdict(
      { channel: 'sms', threadId: PHONE, hash: verdictHash(prompt, firstMessage.at, edited) },
      { verdict: { needs_action: false, category: 'none' }, at: iso(NOW - DAY) },
    );
    const g = gemini();
    const out = await analyze(snapshot(), deps(store, g.client));
    expect(g.generateContent).toHaveBeenCalledTimes(1);
    expect(l1(out.findings)).toHaveLength(1);
  });

  it('never caches an error, a timeout or an unparseable answer', async () => {
    for (const answer of [new Error('The operation was aborted due to timeout'), 'not json at all', '{"category": "none"}']) {
      const store = new MemoryTriageStore();
      const out = await analyze(snapshot(), deps(store, gemini(answer).client));
      expect(out.stats.llmErrors, String(answer)).toBe(1);
      expect(store.verdicts.size, String(answer)).toBe(0);
      const next = gemini();
      await analyze(snapshot(), deps(store, next.client));
      expect(next.generateContent).toHaveBeenCalledTimes(1);
    }
  });

  it('re-asks a cached booked_gap / quote_promised (decided against the calendar and estimates)', async () => {
    for (const category of ['booked_gap', 'quote_promised']) {
      const store = new MemoryTriageStore();
      await analyze(snapshot(), deps(store, gemini(JSON.stringify({ needs_action: true, category, title: 't' })).client));
      const g = gemini('{"needs_action": false, "category": "none"}');
      const out = await analyze(snapshot(), deps(store, g.client));
      expect(g.generateContent, category).toHaveBeenCalledTimes(1);
      expect(out.findings.filter((f) => f.section === category), category).toHaveLength(0);
      expect([...store.verdicts.values()][0].verdict.category, category).toBe('none');
    }
  });

  it('caches email-thread verdicts too, and logs email progress', async () => {
    const email: EmailThreadSnapshot = {
      threadId: '18f00aa',
      subject: 'Bulkhead crack',
      counterparty: 'Pat Doe <pat@example.com>',
      counterpartyAddress: 'pat@example.com',
      lastActivityAt: iso(NOW - DAY),
      messages: [{ direction: 'incoming', at: iso(NOW - DAY), text: 'Can you look at it?', attachmentNames: [] }],
    };
    const store = new MemoryTriageStore();
    const lines: string[] = [];
    await analyze(snapshot([], [email]), deps(store, gemini().client, (m) => lines.push(m)));
    expect([...store.verdicts.keys()][0]).toMatch(/^triage:verdict:email:18f00aa:[0-9a-f]{24}$/);
    expect(lines).toContain('  LLM email 1/1');
    const g = gemini();
    const out = await analyze(snapshot([], [email]), deps(store, g.client));
    expect(g.generateContent).not.toHaveBeenCalled();
    expect(out.findings.filter((f) => f.source === 'L2')).toHaveLength(1);
  });

  it('a failing cache read or write only costs a Gemini call', async () => {
    const store = new MemoryTriageStore();
    store.getVerdict = vi.fn().mockRejectedValue(new Error('upstash 500'));
    store.setVerdict = vi.fn().mockRejectedValue(new Error('upstash 500'));
    const g = gemini();
    const out = await analyze(snapshot(), deps(store, g.client));
    expect(g.generateContent).toHaveBeenCalledTimes(1);
    expect(l1(out.findings)).toHaveLength(1);
    expect(out.stats.llmErrors).toBe(0);
  });
});
