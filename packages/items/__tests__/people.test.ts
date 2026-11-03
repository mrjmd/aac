import { describe, expect, it } from 'vitest';
import { addItemTopic, addTopic, isPending, logConversation, newPerson, setFacts, setTopicStatus } from '../src/people.js';

const now = new Date('2026-11-03T15:00:00Z');
const mike = () => newPerson({ name: 'Mike', role: 'Tech' }, 0, now);

describe('people', () => {
  it('is pending only while a topic is open', () => {
    const p = mike();
    expect(isPending(p)).toBe(false);
    expect(isPending(addTopic(p, { title: 'Cash deposits' }, now))).toBe(true);
  });

  it('adds topics as Prepping by default and trims input', () => {
    const p = addTopic(mike(), { title: '  ATM pulls ', why: ' ' }, now);
    expect(p.topics[0]).toMatchObject({ title: 'ATM pulls', status: 'prep' });
    expect(p.topics[0]).not.toHaveProperty('why');
  });

  it('sends an item to the agenda once, tagging it', () => {
    const item = { key: 'd3:1', title: 'Kowalski check', evidence: 'Not deposited' };
    let p = addItemTopic(mike(), item, now);
    p = addItemTopic(p, item, now);
    expect(p.topics).toHaveLength(1);
    expect(p.topics[0]).toMatchObject({ itemKey: 'd3:1', why: 'Not deposited' });
    expect(p.tagged).toEqual(['d3:1']);
  });

  it('logging drops settled topics, keeps follow-ups, and untags settled items', () => {
    let p = addItemTopic(mike(), { key: 'd3:1', title: 'Kowalski check' }, now);
    p = addTopic(p, { title: 'No-cash rule' }, now);
    const keep = p.topics[1]!.id;
    p = logConversation(p, { at: '2026-11-03', kind: 'call', decided: 'Deposits by Friday', followUp: [keep] });
    expect(p.topics.map((t) => [t.title, t.status])).toEqual([['No-cash rule', 'fup']]);
    expect(p.history[0]).toMatchObject({ kind: 'call', title: 'Kowalski check; No-cash rule', detail: 'Deposits by Friday' });
    expect(p.tagged).toEqual([]);
  });

  it('sets status and drops blank facts', () => {
    let p = addTopic(mike(), { title: 'x' }, now);
    p = setTopicStatus(p, p.topics[0]!.id, 'ready');
    expect(p.topics[0]!.status).toBe('ready');
    expect(setFacts(p, [['Role', 'Tech'], ['', 'x'], ['Pay', ' ']]).facts).toEqual([['Role', 'Tech']]);
  });
});
