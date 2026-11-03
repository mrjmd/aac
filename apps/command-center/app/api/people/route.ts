import { NextRequest, NextResponse } from "next/server";
import {
  addItemTopic,
  addTopic,
  logConversation,
  newPerson,
  nyDate,
  removeTopic,
  setFacts,
  setTopicStatus,
  untag,
  type Person,
  type PersonEventKind,
  type TopicStatus,
} from "@aac/items";
import { getPeopleStore } from "@/lib/people";

/** GET /api/people — everyone, in display order. */
export async function GET() {
  return NextResponse.json(await getPeopleStore().list());
}

type Op =
  | { op: "addPerson"; name: string; role: string; since?: string }
  | { op: "addTopic"; id: string; title: string; why?: string }
  | { op: "addItem"; id: string; item: { key: string; title: string; evidence?: string; detail?: string } }
  | { op: "topicStatus"; id: string; topicId: string; status: TopicStatus }
  | { op: "removeTopic"; id: string; topicId: string }
  | { op: "untag"; id: string; itemKey: string }
  | { op: "had"; id: string; kind: PersonEventKind; decided?: string; followUp?: string[]; at?: string }
  | { op: "facts"; id: string; facts: Array<[string, string]> }
  | { op: "when"; id: string; when: string };

const STATUSES = new Set<TopicStatus>(["prep", "ready", "fup"]);
const KINDS = new Set<PersonEventKind>(["call", "text", "meet", "note"]);

/** POST /api/people  { op, ... } — one change to one person (or a new person). */
export async function POST(request: NextRequest) {
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
    case "untag":
      next = untag(p, body.itemKey);
      break;
    case "had":
      if (!KINDS.has(body.kind)) return bad("bad kind");
      next = logConversation(p, { ...body, at: body.at ?? nyDate(now) });
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
