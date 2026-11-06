/**
 * Where the funnel state, the draft queue, the awaiting-reply list and the
 * runlog live. Redis (replacing the laptop runner's analysis/data JSON
 * files, 2026-11-05) so the cloud worker and the laptop CLI share one
 * state, and the command center reads the queue directly.
 */
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import type { AwaitingFile, EstimateState, FunnelStateFile, QueueFile, RunlogRow } from './types.js';

export interface StaleQuoteStore {
  loadState(): Promise<FunnelStateFile>;
  /** Replace the saved state with this one (entries missing from it are dropped). */
  saveState(state: FunnelStateFile): Promise<void>;
  loadQueue(): Promise<QueueFile | null>;
  saveQueue(queue: QueueFile): Promise<void>;
  loadAwaiting(): Promise<AwaitingFile | null>;
  saveAwaiting(awaiting: AwaitingFile): Promise<void>;
  appendRunlog(rows: RunlogRow[]): Promise<void>;
}

const RUNLOG_MAX = 5000;

/** Upstash hands back parsed JSON for JSON strings; older values may still be raw strings. */
function parse<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

export class RedisStaleQuoteStore implements StaleQuoteStore {
  constructor(private redis: Redis) {}

  async loadState(): Promise<FunnelStateFile> {
    const all = (await this.redis.hgetall<Record<string, unknown>>(keys.staleQuotesState)) ?? {};
    const estimates: Record<string, EstimateState> = {};
    for (const [id, v] of Object.entries(all)) {
      const st = parse<EstimateState>(v);
      if (st) estimates[id] = st;
    }
    return { updatedAt: '', estimates };
  }

  async saveState(state: FunnelStateFile): Promise<void> {
    const entries = Object.fromEntries(Object.entries(state.estimates).map(([id, st]) => [id, JSON.stringify(st)]));
    if (Object.keys(entries).length) await this.redis.hset(keys.staleQuotesState, entries);
    const saved = await this.redis.hkeys(keys.staleQuotesState);
    const gone = saved.filter((id) => !(id in state.estimates));
    if (gone.length) await this.redis.hdel(keys.staleQuotesState, ...gone);
  }

  async loadQueue(): Promise<QueueFile | null> {
    return parse<QueueFile>(await this.redis.get(keys.staleQuotesQueue));
  }

  async saveQueue(queue: QueueFile): Promise<void> {
    await this.redis.set(keys.staleQuotesQueue, JSON.stringify(queue));
  }

  async loadAwaiting(): Promise<AwaitingFile | null> {
    return parse<AwaitingFile>(await this.redis.get(keys.staleQuotesAwaiting));
  }

  async saveAwaiting(awaiting: AwaitingFile): Promise<void> {
    await this.redis.set(keys.staleQuotesAwaiting, JSON.stringify(awaiting));
  }

  async appendRunlog(rows: RunlogRow[]): Promise<void> {
    if (!rows.length) return;
    await this.redis.lpush(keys.staleQuotesRunlog, ...rows.map((r) => JSON.stringify(r)));
    await this.redis.ltrim(keys.staleQuotesRunlog, 0, RUNLOG_MAX - 1);
  }
}

/** In-memory store for tests and replays. */
export class MemoryStaleQuoteStore implements StaleQuoteStore {
  state: FunnelStateFile = { updatedAt: '', estimates: {} };
  queue: QueueFile | null = null;
  awaiting: AwaitingFile | null = null;
  runlog: RunlogRow[] = [];

  async loadState(): Promise<FunnelStateFile> {
    return structuredClone(this.state);
  }
  async saveState(state: FunnelStateFile): Promise<void> {
    this.state = structuredClone(state);
  }
  async loadQueue(): Promise<QueueFile | null> {
    return this.queue;
  }
  async saveQueue(queue: QueueFile): Promise<void> {
    this.queue = queue;
  }
  async loadAwaiting(): Promise<AwaitingFile | null> {
    return this.awaiting;
  }
  async saveAwaiting(awaiting: AwaitingFile): Promise<void> {
    this.awaiting = awaiting;
  }
  async appendRunlog(rows: RunlogRow[]): Promise<void> {
    this.runlog.unshift(...[...rows].reverse());
  }
}
