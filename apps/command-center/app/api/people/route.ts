import { NextRequest, NextResponse } from "next/server";
import {
  addItemTopic,
  addressTopic,
  addTopic,
  logConversation,
  newPerson,
  removeTopic,
  reopenTopic,
  reorderTopics,
  setFacts,
  setTopicStatus,
  untag,
  type Person,
  type PersonEventKind,
  type Topic,
  type TopicStatus,
} from "@aac/items";
import { getPeopleStore } from "@/lib/people";
import { easternDate } from "@aac/shared-utils/eastern";
import { requireApiSession } from "@/lib/api-auth";

/** GET /api/people — everyone, in display order. */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return NextResponse.json(await getPeopleStore().list());
}

type Op =
  | { op: "addPerson"; name: string; role: string; since?: string }
  | { op: "addTopic"; id: string; title: string; why?: string }
  | { op: "addItem"; id: string; item: { key: string; title: string; evidence?: string; detail?: string } }
  | { op: "topicStatus"; id: string; topicId: string; status: TopicStatus }
  | { op: "removeTopic"; id: string; topicId: string }
  | { op: "addressed"; id: string; topicId: string; at?: string }
  | { op: "reopen"; id: string; topic: Topic; at: string }
  | { op: "reorder"; id: string; topicIds: string[] }
  | { op: "untag"; id: string; itemKey: string }
  | { op: "had"; id: string; kind: PersonEventKind; decided?: string; followUp?: string[]; at?: string }
  | { op: "facts"; id: string; facts: Array<[string, string]> }
  | { op: "when"; id: string; when: string };

const STATUSES = new Set<TopicStatus>(["prep", "ready", "fup"]);
const KINDS = new Set<PersonEventKind>(["call", "text", "meet", "note"]);

/** POST /api/people  { op, ... } — one change to one person (or a new person). */
export async function POST(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const body = (await request.json()) as Op;
  const store = getPeopleStore();
  const now = new Date();

  if (body.op === "addPerson") {
    if (!body.name?.trim() || !body.role?.trim()) return bad("name and role required");
    const all = await store.list();
    const p = newPerson(body, (all.at(-1)?.order ?? -1) + 1, now);
    await store.put(p);
    return NextResponse.json(p);
  }

  const p = body.id ? await store.get(body.id) : null;
  if (!p) return NextResponse.json({ error: "person not found" }, { status: 404 });
  let next: Person;
  switch (body.op) {
    case "addTopic":
      if (!body.title?.trim()) return bad("title required");
      next = addTopic(p, body, now);
      break;
    case "addItem":
      if (!body.item?.key || !body.item.title) return bad("item.key and item.title required");
      next = addItemTopic(p, body.item, now);
      break;
    case "topicStatus":
      if (!STATUSES.has(body.status)) return bad("bad status");
      next = setTopicStatus(p, body.topicId, body.status);
      break;
    case "removeTopic":
      next = removeTopic(p, body.topicId);
      break;
    case "addressed":
      next = addressTopic(p, body.topicId, body.at ?? easternDate(now));
      break;
    case "reopen":
      if (!body.topic?.id || !body.topic.title || !STATUSES.has(body.topic.status) || !body.at) return bad("topic and at required");
      next = reopenTopic(p, body.topic, body.at);
      break;
    case "reorder":
      if (!Array.isArray(body.topicIds)) return bad("topicIds required");
      next = reorderTopics(p, body.topicIds);
      break;
    case "untag":
      next = untag(p, body.itemKey);
      break;
    case "had":
      if (!KINDS.has(body.kind)) return bad("bad kind");
      next = logConversation(p, { ...body, at: body.at ?? easternDate(now) });
      break;
    case "facts":
      next = setFacts(p, body.facts ?? []);
      break;
    case "when":
      next = { ...p, when: body.when.trim() };
      break;
    default:
      return bad("unknown op");
  }
  await store.put(next);
  return NextResponse.json(next);
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
