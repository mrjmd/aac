/**
 * Scheduling-intent dispatch for the Quo webhook.
 *
 * The Quo webhook calls `dispatchSchedulingIntent` once per qualifying
 * event (inbound text, outbound text, or completed call transcript).
 * This helper:
 *   1. Splits the event into one or two classification inputs (customer
 *      side, Matt side, or both for transcripts)
 *   2. Runs the Gemini classifier in parallel via Promise.allSettled
 *   3. Dispatches each detected intent to the right normalizer:
 *        - quote_approved | assessment_requested  → normalizeQuoCustomerIntent
 *        - callback_opened                        → resolveCallbackParent
 *                                                 → normalizeQuoCustomerIntent
 *        - manual_schedule                        → normalizeManualSchedule
 *   4. Writes any resulting directives to the shadow queue
 *   5. Returns a summary the caller can include in the webhook response
 *
 * Failures inside the helper never throw to the webhook — they log to
 * `logHealthError` and continue, so the middleware stays alive even when
 * Gemini/Calendar/PD have transient issues.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@aac/shared-utils/logger';
import {
  GeminiClient,
  type ClassifiedSchedulingIntent,
} from '@aac/api-clients/gemini';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import {
  normalizeManualSchedule,
  normalizeQuoCustomerIntent,
  resolveCallbackParent,
  type QuoCallbackParent,
  type QuoCustomerIntentLabel,
  type SchedulingDirective,
} from '@aac/scheduling';
import { logHealthError, trackSchedulingClassification, writePendingDirective } from './redis.js';

const log = createLogger('scheduling-dispatch');

// Same length floor as entity extraction. Avoids spending API calls on
// "ok" / "thanks" / etc.
const MIN_CLASSIFIER_TEXT_LENGTH = 10;

const DEFAULT_TIMEZONE = 'America/New_York';

export type SchedulingEventType =
  | 'message.received'
  | 'message.delivered'
  | 'call.transcript.completed';

export interface DialogueEntry {
  content: string;
  /** True when the line was spoken by an AAC user (Matt). False = customer. */
  isMatt: boolean;
}

export interface SchedulingDispatchContext {
  eventId: string;
  eventType: SchedulingEventType;
  /** For messages — the body text. Ignored for transcripts. */
  text?: string;
  /** For transcripts — the dialogue split. Ignored for messages. */
  dialogue?: DialogueEntry[];
  /** Customer phone in E.164 (already resolved by the webhook). */
  customerPhone: string;
  /** PD person ID (already resolved by the webhook). */
  pdPersonId: number;
}

export interface SchedulingDispatchDeps {
  pd: PipedriveClient;
  cal: GoogleCalendarClient;
  gemini: GeminiClient;
  now?: () => Date;
}

export interface SchedulingDispatchSummary {
  classified: number;
  intentsDetected: number;
  directivesWritten: number;
  callbackParentMisses: number;
  errors: number;
}

interface ClassifierInput {
  text: string;
  speakerRole: 'customer' | 'matt';
}

export async function dispatchSchedulingIntent(
  deps: SchedulingDispatchDeps,
  context: SchedulingDispatchContext,
): Promise<SchedulingDispatchSummary> {
  const summary: SchedulingDispatchSummary = {
    classified: 0,
    intentsDetected: 0,
    directivesWritten: 0,
    callbackParentMisses: 0,
    errors: 0,
  };

  const inputs = extractClassifierInputs(context);
  if (inputs.length === 0) return summary;

  const now = deps.now ?? (() => new Date());

  const settled = await Promise.allSettled(
    inputs.map(async (input) => {
      const classification = await deps.gemini.classifySchedulingIntent(input.text, {
        speakerRole: input.speakerRole,
        now: now(),
        timezone: DEFAULT_TIMEZONE,
      });
      return { input, classification };
    }),
  );

  for (const result of settled) {
    if (result.status === 'rejected') {
      summary.errors++;
      log.error('Classifier failed for one input', result.reason as Error, {
        eventId: context.eventId,
      });
      await logHealthError(
        'quo',
        `Scheduling classifier failed: ${(result.reason as Error)?.message ?? 'unknown'}`,
        { eventId: context.eventId },
      );
      continue;
    }

    summary.classified++;

    const { input, classification } = result.value;
    if (!GeminiClient.hasSchedulingIntent(classification)) continue;
    summary.intentsDetected++;

    try {
      const directive = await buildDirective(deps, context, input, classification!, now);
      if (!directive) {
        // The most common reason: callback_opened without a resolvable parent
        if (classification!.intent === 'callback_opened') {
          summary.callbackParentMisses++;
          await logHealthError(
            'quo',
            'Callback intent detected but parent deal could not be resolved',
            {
              eventId: context.eventId,
              customerPhone: context.customerPhone,
              pdPersonId: String(context.pdPersonId),
            },
          );
        }
        continue;
      }

      await writePendingDirective(directive);
      summary.directivesWritten++;
      log.info('Scheduling directive written', {
        directiveId: directive.id,
        intent: directive.intent,
        source: directive.source,
        confidence: directive.confidence.score,
      });
    } catch (err) {
      summary.errors++;
      log.error('Failed to build/write directive', err as Error, {
        eventId: context.eventId,
        intent: classification!.intent,
      });
      await logHealthError(
        'quo',
        `Directive build failed: ${(err as Error).message}`,
        { eventId: context.eventId, intent: classification!.intent ?? 'unknown' },
      );
    }
  }

  await trackSchedulingClassification(context.eventType, summary);

  return summary;
}

// ── helpers ───────────────────────────────────────────────────────

export function extractClassifierInputs(
  context: SchedulingDispatchContext,
): ClassifierInput[] {
  if (context.eventType === 'message.received') {
    const text = (context.text ?? '').trim();
    if (text.length < MIN_CLASSIFIER_TEXT_LENGTH) return [];
    return [{ text, speakerRole: 'customer' }];
  }

  if (context.eventType === 'message.delivered') {
    const text = (context.text ?? '').trim();
    if (text.length < MIN_CLASSIFIER_TEXT_LENGTH) return [];
    return [{ text, speakerRole: 'matt' }];
  }

  // call.transcript.completed — classify both sides if either has enough text
  const dialogue = context.dialogue ?? [];
  const customerText = dialogue
    .filter((d) => !d.isMatt)
    .map((d) => d.content)
    .join(' ')
    .trim();
  const mattText = dialogue
    .filter((d) => d.isMatt)
    .map((d) => d.content)
    .join(' ')
    .trim();

  const out: ClassifierInput[] = [];
  if (customerText.length >= MIN_CLASSIFIER_TEXT_LENGTH) {
    out.push({ text: customerText, speakerRole: 'customer' });
  }
  if (mattText.length >= MIN_CLASSIFIER_TEXT_LENGTH) {
    out.push({ text: mattText, speakerRole: 'matt' });
  }
  return out;
}

async function buildDirective(
  deps: SchedulingDispatchDeps,
  context: SchedulingDispatchContext,
  input: ClassifierInput,
  classification: ClassifiedSchedulingIntent,
  now: () => Date,
): Promise<SchedulingDirective | null> {
  const normalizerDeps = { newId: () => randomUUID(), now };
  const source = context.eventType === 'call.transcript.completed' ? 'quo_call' : 'quo_text';

  if (input.speakerRole === 'matt') {
    // Matt outbound — manual_schedule only
    if (classification.intent !== 'manual_schedule') return null;
    return normalizeManualSchedule(normalizerDeps, {
      classification: {
        score: classification.score,
        ...(classification.eventClass ? { eventClass: classification.eventClass } : {}),
        ...(classification.knownSlot ? { knownSlot: classification.knownSlot } : {}),
        scopeSummary: classification.scopeSummary,
      },
      customer: {
        customerPhone: context.customerPhone,
        pdPersonId: context.pdPersonId,
      },
    });
  }

  // Customer side
  if (
    classification.intent !== 'quote_approved'
    && classification.intent !== 'assessment_requested'
    && classification.intent !== 'callback_opened'
  ) {
    return null;
  }

  const customerName = await fetchPdPersonName(deps.pd, context.pdPersonId);

  let callbackParent: QuoCallbackParent | undefined;
  if (classification.intent === 'callback_opened') {
    if (!customerName) {
      log.warn('Cannot resolve callback parent without customer name', {
        pdPersonId: context.pdPersonId,
      });
      return null;
    }
    const resolved = await resolveCallbackParent(
      { cal: deps.cal },
      { customerName, now },
    );
    if (!resolved) return null;
    callbackParent = resolved;
  }

  return normalizeQuoCustomerIntent(normalizerDeps, {
    classification: {
      intent: classification.intent as QuoCustomerIntentLabel,
      score: classification.score,
      rationale: classification.rationale,
      scopeSummary: classification.scopeSummary,
    },
    customer: {
      customerPhone: context.customerPhone,
      pdPersonId: context.pdPersonId,
      pdPersonName: customerName ?? `PD ${context.pdPersonId}`,
    },
    source: source as 'quo_text' | 'quo_call',
    ...(callbackParent ? { callbackParent } : {}),
  });
}

async function fetchPdPersonName(
  pd: PipedriveClient,
  pdPersonId: number,
): Promise<string | null> {
  try {
    const person = await pd.getPerson(pdPersonId);
    return person?.name ?? null;
  } catch (err) {
    log.warn('PD getPerson failed during scheduling dispatch', {
      pdPersonId,
      error: (err as Error).message,
    });
    return null;
  }
}
