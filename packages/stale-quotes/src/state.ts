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
  /** The saved entries for these estimate ids (missing ids are absent). */
  loadEstimates(ids: string[]): Promise<Record<string, EstimateState>>;
  /** Write these entries, leaving every other entry as it is. */
  saveEstimates(sts: EstimateState[]): Promise<void>;
  deleteEstimates(ids: string[]): Promise<void>;
  loadQueue(): Promise<QueueFile | null>;
  saveQueue(queue: QueueFile): Promise<void>;
  loadAwaiting(): Promise<AwaitingFile | null>;
  saveAwaiting(awaiting: AwaitingFile): Promise<void>;
  appendRunlog(rows: RunlogRow[]): Promise<void>;
}

const RUNLOG_MAX = 5000;

/**
 * Three-way merge of one estimate's entry, field by field. `base` is what
 * this run last read or wrote, `mine` the run's copy, `theirs` what is saved
 * now. A field someone else changed since `base` (an owner hand-set stated
 * timing, a touch from an overlapping run) keeps their value; every other
 * field takes the run's.
 */
export function mergeEstimate(base: EstimateState | undefined, mine: EstimateState, theirs: EstimateState | undefined): EstimateState {
  if (!theirs) return mine;
  const b = (base ?? {}) as unknown as Record<string, unknown>;
  const t = theirs as unknown as Record<string, unknown>;
  const out = { ...mine } as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(t)])) {
    if (JSON.stringify(t[k]) === JSON.stringify(b[k])) continue;
    if (t[k] === undefined) delete out[k];
    else out[k] = t[k];
  }
  return out as unknown as EstimateState;
}

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

  async loadEstimates(ids: string[]): Promise<Record<string, EstimateState>> {
    const out: Record<string, EstimateState> = {};
    if (!ids.length) return out;
    const vals = await this.redis.hmget<Record<string, unknown>>(keys.staleQuotesState, ...ids);
    for (const id of ids) {
      const st = parse<EstimateState>(vals?.[id]);
      if (st) out[id] = st;
    }
    return out;
  }

  async saveEstimates(sts: EstimateState[]): Promise<void> {
    if (!sts.length) return;
    await this.redis.hset(keys.staleQuotesState, Object.fromEntries(sts.map((st) => [st.estimateId, JSON.stringify(st)])));
  }

  async deleteEstimates(ids: string[]): Promise<void> {
    if (ids.length) await this.redis.hdel(keys.staleQuotesState, ...ids);
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
  async loadEstimates(ids: string[]): Promise<Record<string, EstimateState>> {
    return structuredClone(Object.fromEntries(ids.filter((id) => this.state.estimates[id]).map((id) => [id, this.state.estimates[id]])));
  }
  async saveEstimates(sts: EstimateState[]): Promise<void> {
    for (const st of sts) this.state.estimates[st.estimateId] = structuredClone(st);
  }
  async deleteEstimates(ids: string[]): Promise<void> {
    for (const id of ids) delete this.state.estimates[id];
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
