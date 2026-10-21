/**
 * Fast-lane handoff to apps/worker (launchd → server-workers P1).
 *
 * The worker acks 202 in milliseconds and finishes via its own waitUntil,
 * so awaiting this adds only one round-trip to a webhook handler. Fails
 * soft by design: the Redis queue written beforehand is the source of
 * truth and the worker/laptop tick drains it within ~60s regardless.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from './env.js';

const log = createLogger('worker-notify');

export async function notifyWorkerFollowup(estimateId: string): Promise<void> {
  const { worker } = getEnv();
  if (!worker.baseUrl || !worker.sharedSecret) return;
  try {
    const res = await fetch(`${worker.baseUrl}/api/draft-followup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': worker.sharedSecret,
      },
      body: JSON.stringify({ estimateId }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 202) {
      log.warn('worker fast lane returned non-202', { estimateId, status: res.status });
    }
  } catch (err) {
    log.warn('worker fast lane unreachable — tick will drain the queue', {
      estimateId,
      error: (err as Error).message,
    });
  }
}
