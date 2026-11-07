import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

/**
 * "This looks wrong" (every card and tile): one tap saves the card's text
 * as it was on screen plus Matt's note. Nothing pings anyone; Claude reads
 * the open ones at the start of each session and fixes them first, then
 * marks them fixed with what changed (System shows both).
 */
export interface CardFlag {
  id: string;
  at: string;
  /** Path the card was on, e.g. "/month". */
  page: string;
  /** The card's heading. */
  card: string;
  note: string;
  /** The card's visible text when flagged (capped), so the numbers he saw are on record. */
  text: string;
  fixedAt?: string;
  /** What was wrong and what changed. */
  fix?: string;
}

export const TEXT_MAX = 4000;

/** Open first (newest first), then fixed (newest fix first). */
export async function listCardFlags(): Promise<CardFlag[]> {
  const all = Object.values((await getRedis().hgetall<Record<string, CardFlag>>(keys.ccCardFlags)) ?? {});
  return all.sort((a, b) => (!!a.fixedAt === !!b.fixedAt ? (b.fixedAt ?? b.at).localeCompare(a.fixedAt ?? a.at) : a.fixedAt ? 1 : -1));
}

export async function addCardFlag(input: { page: string; card: string; note: string; text: string }, now = new Date()): Promise<CardFlag> {
  const flag: CardFlag = {
    id: crypto.randomUUID(),
    at: now.toISOString(),
    page: input.page.slice(0, 200),
    card: input.card.slice(0, 200),
    note: input.note.slice(0, 2000),
    text: input.text.slice(0, TEXT_MAX),
  };
  await getRedis().hset(keys.ccCardFlags, { [flag.id]: flag });
  return flag;
}

/** Mark one fixed; null when the id doesn't exist. */
export async function fixCardFlag(id: string, fix: string, now = new Date()): Promise<CardFlag | null> {
  const flag = await getRedis().hget<CardFlag>(keys.ccCardFlags, id);
  if (!flag) return null;
  const next: CardFlag = { ...flag, fixedAt: now.toISOString(), ...(fix ? { fix: fix.slice(0, 2000) } : {}) };
  await getRedis().hset(keys.ccCardFlags, { [id]: next });
  return next;
}
