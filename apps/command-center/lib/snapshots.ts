import { gunzipSync, gzipSync } from "node:zlib";
import { after } from "next/server";
import { keys, ttl } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

/**
 * Saved card data. Pages render from these instead of calling QuickBooks,
 * Quo, Gmail or the calendar on every load; each card shows how old its
 * snapshot is and can be refreshed on its own. Values are gzip+base64 JSON
 * so a whole calendar index fits comfortably in one Redis value.
 */
export interface Snapshot<T> {
  data: T;
  /** ISO time the source was last read. */
  fetchedAt: string;
}

function encode<T>(s: Snapshot<T>): string {
  return gzipSync(JSON.stringify(s)).toString("base64");
}

function decode<T>(raw: unknown): Snapshot<T> | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as Snapshot<T>;
  } catch {
    return null;
  }
}

export async function readSnapshot<T>(name: string): Promise<Snapshot<T> | null> {
  return decode<T>(await getRedis().get<string>(keys.ccSnapshot(name)));
}

/** Read the source now and save it. */
export async function refreshSnapshot<T>(name: string, fetch: () => Promise<T>): Promise<Snapshot<T>> {
  const snap: Snapshot<T> = { data: await fetch(), fetchedAt: new Date().toISOString() };
  await getRedis().set(keys.ccSnapshot(name), encode(snap), { ex: ttl.ccSnapshot });
  return snap;
}

/**
 * The saved snapshot, right away. Only the very first read of a card waits
 * on the source. When the snapshot is older than `maxAgeMs` the page still
 * renders it, and a refresh runs after the response so the next view is
 * current.
 */
export async function snapshot<T>(name: string, fetch: () => Promise<T>, maxAgeMs: number): Promise<Snapshot<T>> {
  const saved = await readSnapshot<T>(name);
  if (!saved) return refreshSnapshot(name, fetch);
  if (Date.now() - Date.parse(saved.fetchedAt) > maxAgeMs) {
    after(() => refreshSnapshot(name, fetch).catch(() => undefined));
  }
  return saved;
}
