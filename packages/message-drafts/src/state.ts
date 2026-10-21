/**
 * Shared dedup/claim state for the message-drafts pipeline.
 *
 * Lives in Redis hashes (replacing the laptop runner's state.json,
 * 2026-10-21) so the Vercel worker's fast lane, its backstop sweeps, and
 * the laptop runner can all run concurrently without double-posting: an
 * actor must CLAIM an estimate/phone (HSETNX) before drafting, and a
 * `pending:` claim left by a crashed actor goes stale after
 * CLAIM_STALE_MIN and may be reclaimed.
 */
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { CLAIM_STALE_MIN } from './types.js';

export interface DraftState {
  /** Current done/claim marker for an estimate (iso | skipped:* | pending:iso). */
  getFollowup(estimateId: string): Promise<string | null>;
  /** Atomically claim an estimate for drafting. False = someone else owns it. */
  claimFollowup(estimateId: string): Promise<boolean>;
  setFollowup(estimateId: string, value: string): Promise<void>;
  /** Drop a claim after a failed post so a later pass retries. */
  releaseFollowup(estimateId: string): Promise<void>;

  getIntake(phone: string): Promise<string | null>;
  claimIntake(phone: string): Promise<boolean>;
  setIntake(phone: string, value: string): Promise<void>;
  releaseIntake(phone: string): Promise<void>;

  getNoteAttempts(phone: string): Promise<number>;
  incrNoteAttempts(phone: string): Promise<number>;
  clearNoteAttempts(phone: string): Promise<void>;

  getFirstRunAt(): Promise<string | null>;
  setFirstRunAt(iso: string): Promise<void>;

  /** Append an audit record (capped list). Best-effort. */
  appendRecord(record: Record<string, unknown>): Promise<void>;
}

/** A claim is "done" unless it's a stale pending: marker from a crash. */
export function isDone(marker: string | null, nowMs: number): boolean {
  if (!marker) return false;
  if (!marker.startsWith('pending:')) return true;
  const at = new Date(marker.slice('pending:'.length)).getTime();
  return Number.isFinite(at) && nowMs - at < CLAIM_STALE_MIN * 60_000;
}

export class RedisDraftState implements DraftState {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  private pendingMarker(): string {
    return `pending:${new Date(this.now()).toISOString()}`;
  }

  private async claim(hash: string, field: string): Promise<boolean> {
    const claimed = await this.redis.hsetnx(hash, field, this.pendingMarker());
    if (claimed === 1) return true;
    // Stale pending claim from a crashed actor → take it over.
    const existing = await this.redis.hget<string>(hash, field);
    if (existing && !isDone(existing, this.now())) {
      await this.redis.hset(hash, { [field]: this.pendingMarker() });
      return true;
    }
    return false;
  }

  getFollowup(id: string): Promise<string | null> {
    return this.redis.hget<string>(keys.messageDraftFollowupDone, id);
  }
  claimFollowup(id: string): Promise<boolean> {
    return this.claim(keys.messageDraftFollowupDone, id);
  }
  async setFollowup(id: string, value: string): Promise<void> {
    await this.redis.hset(keys.messageDraftFollowupDone, { [id]: value });
  }
  async releaseFollowup(id: string): Promise<void> {
    await this.redis.hdel(keys.messageDraftFollowupDone, id);
  }

  getIntake(phone: string): Promise<string | null> {
    return this.redis.hget<string>(keys.messageDraftIntakeDone, phone);
  }
  claimIntake(phone: string): Promise<boolean> {
    return this.claim(keys.messageDraftIntakeDone, phone);
  }
  async setIntake(phone: string, value: string): Promise<void> {
    await this.redis.hset(keys.messageDraftIntakeDone, { [phone]: value });
  }
  async releaseIntake(phone: string): Promise<void> {
    await this.redis.hdel(keys.messageDraftIntakeDone, phone);
  }

  async getNoteAttempts(phone: string): Promise<number> {
    const v = await this.redis.hget<number>(keys.messageDraftNoteAttempts, phone);
    return Number(v ?? 0);
  }
  async incrNoteAttempts(phone: string): Promise<number> {
    return this.redis.hincrby(keys.messageDraftNoteAttempts, phone, 1);
  }
  async clearNoteAttempts(phone: string): Promise<void> {
    await this.redis.hdel(keys.messageDraftNoteAttempts, phone);
  }

  getFirstRunAt(): Promise<string | null> {
    return this.redis.get<string>(keys.messageDraftFirstRunAt);
  }
  async setFirstRunAt(iso: string): Promise<void> {
    await this.redis.set(keys.messageDraftFirstRunAt, iso);
  }

  async appendRecord(record: Record<string, unknown>): Promise<void> {
    try {
      await this.redis.lpush(keys.messageDraftRunlog, JSON.stringify(record));
      await this.redis.ltrim(keys.messageDraftRunlog, 0, 499);
    } catch {
      // audit trail is best-effort
    }
  }
}

/** In-memory state for tests and --dry-run probes. */
export class MemoryDraftState implements DraftState {
  followup = new Map<string, string>();
  intake = new Map<string, string>();
  attempts = new Map<string, number>();
  firstRunAt: string | null = null;
  records: Array<Record<string, unknown>> = [];

  constructor(private readonly now: () => number = Date.now) {}

  private claimFrom(map: Map<string, string>, key: string): boolean {
    const existing = map.get(key) ?? null;
    if (existing && isDone(existing, this.now())) return false;
    map.set(key, `pending:${new Date(this.now()).toISOString()}`);
    return true;
  }

  async getFollowup(id: string): Promise<string | null> {
    return this.followup.get(id) ?? null;
  }
  async claimFollowup(id: string): Promise<boolean> {
    return this.claimFrom(this.followup, id);
  }
  async setFollowup(id: string, value: string): Promise<void> {
    this.followup.set(id, value);
  }
  async releaseFollowup(id: string): Promise<void> {
    this.followup.delete(id);
  }

  async getIntake(phone: string): Promise<string | null> {
    return this.intake.get(phone) ?? null;
  }
  async claimIntake(phone: string): Promise<boolean> {
    return this.claimFrom(this.intake, phone);
  }
  async setIntake(phone: string, value: string): Promise<void> {
    this.intake.set(phone, value);
  }
  async releaseIntake(phone: string): Promise<void> {
    this.intake.delete(phone);
  }

  async getNoteAttempts(phone: string): Promise<number> {
    return this.attempts.get(phone) ?? 0;
  }
  async incrNoteAttempts(phone: string): Promise<number> {
    const n = (this.attempts.get(phone) ?? 0) + 1;
    this.attempts.set(phone, n);
    return n;
  }
  async clearNoteAttempts(phone: string): Promise<void> {
    this.attempts.delete(phone);
  }

  async getFirstRunAt(): Promise<string | null> {
    return this.firstRunAt;
  }
  async setFirstRunAt(iso: string): Promise<void> {
    this.firstRunAt = iso;
  }

  async appendRecord(record: Record<string, unknown>): Promise<void> {
    this.records.push(record);
  }
}
