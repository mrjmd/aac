import { keys } from '@aac/shared-utils/redis';
import type { ItemCandidate, ItemState, MuteRule } from './types.js';

export interface CandidateSnapshot {
  /** When the detectors ran. */
  at: string;
  /** Who wrote it, e.g. "triage-laptop" or "worker". */
  source: string;
  candidates: ItemCandidate[];
}

/**
 * The Upstash calls the store uses. Structural, so apps can pass whichever
 * @upstash/redis copy they resolve.
 */
export interface ItemRedis {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<unknown>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
}

/** Redis persistence for items. Upstash auto-serializes JSON values. */
export class ItemStore {
  constructor(private redis: ItemRedis) {}

  async getCandidates(): Promise<CandidateSnapshot | null> {
    return this.redis.get<CandidateSnapshot>(keys.itemCandidates);
  }

  async putCandidates(snapshot: CandidateSnapshot): Promise<void> {
    await this.redis.set(keys.itemCandidates, snapshot);
  }

  async getStates(): Promise<Record<string, ItemState>> {
    return (await this.redis.hgetall<Record<string, ItemState>>(keys.itemStates)) ?? {};
  }

  async putStates(states: Record<string, ItemState>): Promise<void> {
    if (Object.keys(states).length) await this.redis.hset(keys.itemStates, states);
  }

  async deleteStates(stateKeys: string[]): Promise<void> {
    if (stateKeys.length) await this.redis.hdel(keys.itemStates, ...stateKeys);
  }

  async getMutes(): Promise<MuteRule[]> {
    const all = (await this.redis.hgetall<Record<string, MuteRule>>(keys.itemMutes)) ?? {};
    return Object.values(all);
  }

  async putMute(rule: MuteRule): Promise<void> {
    await this.redis.hset(keys.itemMutes, { [rule.id]: rule });
  }

  async deleteMute(id: string): Promise<void> {
    await this.redis.hdel(keys.itemMutes, id);
  }
}
