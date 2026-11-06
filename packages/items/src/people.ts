import { keys } from '@aac/shared-utils/redis';
import type { Item } from './types.js';

/**
 * People: staff and partners Matt needs to talk to (Mike, Ed). Each person
 * carries an agenda of open topics, a log of past conversations, the items
 * tagged to them, and a few facts. Topics come from Matt ("+ Topic") or from
 * any item (⋯ → "Mike's agenda"). Logging a conversation drops the topics it
 * settled and marks the rest Follow up. A person is "pending" (shows on
 * Today) while any topic is open.
 */

export type TopicStatus = 'prep' | 'ready' | 'fup';

export interface Topic {
  id: string;
  title: string;
  why?: string;
  status: TopicStatus;
  /** The item this topic came from, if any. */
  itemKey?: string;
  addedAt: string;
}

export type PersonEventKind = 'call' | 'text' | 'meet' | 'note';

export interface PersonEvent {
  /** YYYY-MM-DD. */
  at: string;
  kind: PersonEventKind;
  title: string;
  detail?: string;
  /** Titles of topics checked off one at a time that day (see `addressTopic`). */
  addressed?: string[];
}

export interface Person {
  id: string;
  name: string;
  role: string;
  /** One line under the name on the People page, e.g. "Since Jul 2024". */
  since?: string;
  /** When the next conversation should happen, e.g. "Before Friday payroll". */
  when?: string;
  topics: Topic[];
  /** Newest first. */
  history: PersonEvent[];
  facts: Array<[string, string]>;
  /** Item keys tagged to this person. */
  tagged: string[];
  order: number;
  createdAt: string;
}

export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = { ready: 'Ready', prep: 'Prepping', fup: 'Follow up' };

const newId = () => globalThis.crypto.randomUUID().slice(0, 8);

export function newPerson(input: { name: string; role: string; since?: string }, order: number, now: Date): Person {
  return {
    id: newId(),
    name: input.name.trim(),
    role: input.role.trim(),
    ...(input.since ? { since: input.since } : {}),
    topics: [],
    history: [],
    facts: [],
    tagged: [],
    order,
    createdAt: now.toISOString(),
  };
}

/** A person with open topics belongs on Today. */
export const isPending = (p: Person) => p.topics.length > 0;

export function addTopic(p: Person, input: { title: string; why?: string; status?: TopicStatus }, now: Date): Person {
  const topic: Topic = {
    id: newId(),
    title: input.title.trim(),
    ...(input.why?.trim() ? { why: input.why.trim() } : {}),
    status: input.status ?? 'prep',
    addedAt: now.toISOString(),
  };
  return { ...p, topics: [...p.topics, topic] };
}

/**
 * Send an item to someone's agenda: a Prepping topic carrying the item's
 * title and evidence, and a tag. Sending the same item twice is a no-op.
 */
export function addItemTopic(
  p: Person,
  item: Pick<Item, 'key' | 'title' | 'evidence' | 'detail'>,
  now: Date,
): Person {
  const tagged = p.tagged.includes(item.key) ? p.tagged : [...p.tagged, item.key];
  if (p.topics.some((t) => t.itemKey === item.key)) return { ...p, tagged };
  const why = item.evidence ?? item.detail;
  const withTopic = addTopic(p, { title: item.title, ...(why ? { why } : {}) }, now);
  const topics = withTopic.topics.map((t, i) => (i === withTopic.topics.length - 1 ? { ...t, itemKey: item.key } : t));
  return { ...p, topics, tagged };
}

export function setTopicStatus(p: Person, topicId: string, status: TopicStatus): Person {
  return { ...p, topics: p.topics.map((t) => (t.id === topicId ? { ...t, status } : t)) };
}

export function removeTopic(p: Person, topicId: string): Person {
  return { ...p, topics: p.topics.filter((t) => t.id !== topicId) };
}

/** Put topics in the dragged order; any topic the list doesn't name keeps its place at the end. */
export function reorderTopics(p: Person, topicIds: string[]): Person {
  const rank = (t: Topic) => {
    const i = topicIds.indexOf(t.id);
    return i < 0 ? topicIds.length : i;
  };
  return { ...p, topics: [...p.topics].sort((a, b) => rank(a) - rank(b)) };
}

export function untag(p: Person, itemKey: string): Person {
  return { ...p, tagged: p.tagged.filter((k) => k !== itemKey) };
}

/**
 * Log a conversation: one history entry naming what was covered and what
 * was decided. Topics in `followUp` stay on the agenda as Follow up; every
 * other open topic was settled and drops off.
 */
export function logConversation(
  p: Person,
  input: { at: string; kind: PersonEventKind; decided?: string; followUp?: string[] },
): Person {
  const keep = new Set(input.followUp ?? []);
  const settled = p.topics.filter((t) => !keep.has(t.id));
  const covered = p.topics.map((t) => t.title);
  const event: PersonEvent = {
    at: input.at,
    kind: input.kind,
    title: covered.length ? covered.join('; ') : 'Check-in',
    ...(input.decided?.trim() ? { detail: input.decided.trim() } : {}),
  };
  return {
    ...p,
    topics: p.topics.filter((t) => keep.has(t.id)).map((t) => ({ ...t, status: 'fup' as const })),
    history: [event, ...p.history],
    // Items behind settled topics are handled as far as this person goes.
    tagged: p.tagged.filter((k) => !settled.some((t) => t.itemKey === k)),
  };
}

/**
 * Check off one topic: it leaves the agenda and joins that day's
 * "Addressed" history entry (one per day, so a call that covers three of
 * seven topics reads as one line). The item behind it is untagged.
 */
export function addressTopic(p: Person, topicId: string, at: string): Person {
  const topic = p.topics.find((t) => t.id === topicId);
  if (!topic) return p;
  const [head, ...rest] = p.history;
  const merged = head?.at === at ? head.addressed : undefined;
  const addressed = [...(merged ?? []), topic.title];
  const event: PersonEvent = { at, kind: 'note', title: `Addressed: ${addressed.join('; ')}`, addressed };
  return {
    ...p,
    topics: p.topics.filter((t) => t.id !== topicId),
    history: merged ? [event, ...rest] : [event, ...p.history],
    tagged: topic.itemKey ? p.tagged.filter((k) => k !== topic.itemKey) : p.tagged,
  };
}

/** Undo `addressTopic`: the topic goes back on the agenda and off that day's entry. */
export function reopenTopic(p: Person, topic: Topic, at: string): Person {
  if (p.topics.some((t) => t.id === topic.id)) return p;
  const history = p.history.flatMap((e) => {
    if (e.at !== at || !e.addressed?.includes(topic.title)) return [e];
    const i = e.addressed.indexOf(topic.title);
    const addressed = e.addressed.filter((_, n) => n !== i);
    return addressed.length ? [{ ...e, title: `Addressed: ${addressed.join('; ')}`, addressed }] : [];
  });
  const tagged = topic.itemKey && !p.tagged.includes(topic.itemKey) ? [...p.tagged, topic.itemKey] : p.tagged;
  return { ...p, topics: [...p.topics, topic], history, tagged };
}

export function setFacts(p: Person, facts: Array<[string, string]>): Person {
  return { ...p, facts: facts.filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()]) };
}

/** The Upstash calls the people store uses. */
export interface PeopleRedis {
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
}

/** Redis persistence for people: one hash field per person. */
export class PeopleStore {
  constructor(private redis: PeopleRedis) {}

  async list(): Promise<Person[]> {
    const all = (await this.redis.hgetall<Record<string, Person>>(keys.ccPeople)) ?? {};
    return Object.values(all).sort((a, b) => a.order - b.order);
  }

  async get(id: string): Promise<Person | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  async put(p: Person): Promise<void> {
    await this.redis.hset(keys.ccPeople, { [p.id]: p });
  }

  async remove(id: string): Promise<void> {
    await this.redis.hdel(keys.ccPeople, id);
  }
}
