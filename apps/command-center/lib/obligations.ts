import { markObligationDone, type Obligation } from "@aac/items";
import { easternDate } from "@aac/shared-utils/eastern";
import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

/** Important dates (Admin): one JSON list in Redis, owned by the command center. */
export async function loadObligations(): Promise<Obligation[]> {
  return (await getRedis().get<Obligation[]>(keys.ccObligations).catch(() => null)) ?? [];
}

async function save(list: Obligation[]): Promise<Obligation[]> {
  await getRedis().set(keys.ccObligations, JSON.stringify(list));
  return list;
}

export type ObligationOp =
  | { op: "done"; id: string }
  | { op: "set"; id: string; due: string | null; confirmed?: boolean };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isObligationOp(b: unknown): b is ObligationOp {
  const o = (b ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return false;
  if (o.op === "done") return true;
  return o.op === "set" && (o.due === null || (typeof o.due === "string" && DAY_RE.test(o.due))) && (o.confirmed === undefined || typeof o.confirmed === "boolean");
}

/** Apply one change; null when the id doesn't exist. */
export async function changeObligation(op: ObligationOp, now = new Date()): Promise<Obligation[] | null> {
  const list = await loadObligations();
  const i = list.findIndex((o) => o.id === op.id);
  if (i < 0) return null;
  const o = list[i]!;
  list[i] =
    op.op === "done"
      ? markObligationDone(o, easternDate(now))
      : { ...o, due: op.due, closed: false, ...(op.confirmed !== undefined ? { confirmed: op.confirmed } : { confirmed: true }) };
  return save(list);
}
