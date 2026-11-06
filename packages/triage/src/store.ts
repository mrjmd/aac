/**
 * TriageStore — the triage pipeline's only persistent state outside the
 * snapshot/findings it returns. Replaces the laptop files under
 * analysis/data/triage/:
 *
 *   transcripts/{callId}.json     → triage:transcript:{callId}
 *   transcripts/vm-{callId}.json  → triage:voicemail:{callId}
 *   dismissals.json               → triage:dismissals
 *
 * Values are the same JSON objects the files hold, so a call is fetched
 * from Quo once ever, whether the worker or a manual run sees it first.
 * No TTLs: a completed call's transcript and a rang-out call's 404 are
 * immutable.
 *
 * Plus the per-thread L1/L2 verdict cache (triage:verdict:..., 7-day TTL;
 * plan decision 2), shared by the worker and manual runs.
 */

import type { Redis } from '@upstash/redis';
import { keys, ttl } from '@aac/shared-utils/redis';
import type { Section } from './types.js';

/** transcripts/{callId}.json */
export interface CachedTranscript {
  phone: string;
  at: string;
  dialogue: Array<Record<string, unknown>>;
}

/** transcripts/vm-{callId}.json. `transcript: null` = the call has no voicemail (404). */
export interface CachedVoicemail {
  phone: string;
  at: string;
  transcript: string | null;
}

/**
 * One owner-curated suppression. `match` is checked case-insensitively
 * against customer, title and phone; `until` (YYYY-MM-DD) makes it a
 * temporary hold.
 */
export interface DismissalRule {
  match: string;
  sections?: Section[];
  reason?: string;
  addedAt?: string;
  until?: string;
}

/** Which cached verdict: the channel, the thread (phone or Gmail thread id) and the input hash. */
export interface VerdictCacheId {
  channel: 'sms' | 'email';
  threadId: string;
  hash: string;
}

/** One cached Gemini verdict (the parsed JSON object) and when it was asked. */
export interface CachedVerdict {
  verdict: Record<string, unknown>;
  at: string;
}

export interface TriageStore {
  getTranscript(callId: string): Promise<CachedTranscript | null>;
  setTranscript(callId: string, value: CachedTranscript): Promise<void>;
  getVoicemail(callId: string): Promise<CachedVoicemail | null>;
  setVoicemail(callId: string, value: CachedVoicemail): Promise<void>;
  /** null = no dismissals configured (the file did not exist). */
  loadDismissals(): Promise<DismissalRule[] | null>;
  setDismissals(rules: DismissalRule[]): Promise<void>;
  getVerdict(id: VerdictCacheId): Promise<CachedVerdict | null>;
  /** Expires after ttl.triageVerdict. */
  setVerdict(id: VerdictCacheId, value: CachedVerdict): Promise<void>;
}

/** Upstash parses JSON values on read; tolerate a raw string too. */
function parsed<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export class RedisTriageStore implements TriageStore {
  constructor(private readonly redis: Redis) {}

  async getTranscript(callId: string): Promise<CachedTranscript | null> {
    return parsed<CachedTranscript>(await this.redis.get(keys.triageTranscript(callId)));
  }

  async setTranscript(callId: string, value: CachedTranscript): Promise<void> {
    await this.redis.set(keys.triageTranscript(callId), JSON.stringify(value));
  }

  async getVoicemail(callId: string): Promise<CachedVoicemail | null> {
    return parsed<CachedVoicemail>(await this.redis.get(keys.triageVoicemail(callId)));
  }

  async setVoicemail(callId: string, value: CachedVoicemail): Promise<void> {
    await this.redis.set(keys.triageVoicemail(callId), JSON.stringify(value));
  }

  async loadDismissals(): Promise<DismissalRule[] | null> {
    return parsed<DismissalRule[]>(await this.redis.get(keys.triageDismissals));
  }

  async setDismissals(rules: DismissalRule[]): Promise<void> {
    await this.redis.set(keys.triageDismissals, JSON.stringify(rules));
  }

  async getVerdict(id: VerdictCacheId): Promise<CachedVerdict | null> {
    return parsed<CachedVerdict>(await this.redis.get(keys.triageVerdict(id.channel, id.threadId, id.hash)));
  }

  async setVerdict(id: VerdictCacheId, value: CachedVerdict): Promise<void> {
    await this.redis.set(keys.triageVerdict(id.channel, id.threadId, id.hash), JSON.stringify(value), {
      ex: ttl.triageVerdict,
    });
  }
}

/** In-process store: tests, the identity proof, and dry runs that must not write Redis. */
export class MemoryTriageStore implements TriageStore {
  readonly transcripts = new Map<string, CachedTranscript>();
  readonly voicemails = new Map<string, CachedVoicemail>();
  dismissals: DismissalRule[] | null = null;
  /** By the Redis key string; no expiry (a process outlives no TTL that matters). */
  readonly verdicts = new Map<string, CachedVerdict>();

  async getTranscript(callId: string): Promise<CachedTranscript | null> {
    return this.transcripts.get(callId) ?? null;
  }

  async setTranscript(callId: string, value: CachedTranscript): Promise<void> {
    this.transcripts.set(callId, value);
  }

  async getVoicemail(callId: string): Promise<CachedVoicemail | null> {
    return this.voicemails.get(callId) ?? null;
  }

  async setVoicemail(callId: string, value: CachedVoicemail): Promise<void> {
    this.voicemails.set(callId, value);
  }

  async loadDismissals(): Promise<DismissalRule[] | null> {
    return this.dismissals;
  }

  async setDismissals(rules: DismissalRule[]): Promise<void> {
    this.dismissals = rules;
  }

  async getVerdict(id: VerdictCacheId): Promise<CachedVerdict | null> {
    return this.verdicts.get(keys.triageVerdict(id.channel, id.threadId, id.hash)) ?? null;
  }

  async setVerdict(id: VerdictCacheId, value: CachedVerdict): Promise<void> {
    this.verdicts.set(keys.triageVerdict(id.channel, id.threadId, id.hash), value);
  }
}
