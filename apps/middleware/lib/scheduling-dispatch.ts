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
  ExtractionError,
  GeminiClient,
  type ClassifiedSchedulingIntent,
} from '@aac/api-clients/gemini';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import {
  PIPEDRIVE_CROSS_SYSTEM_FIELDS,
  type PipedriveClient,
  type PipedrivePerson,
} from '@aac/api-clients/pipedrive';
import type { QuoClient } from '@aac/api-clients/quo';
import {
  buildEventDescription,
  collectStubPhotoAttachments,
  executeStubEvent,
  getActionableSlot,
  normalizeAppointmentConfirmed,
  normalizeManualSchedule,
  normalizeQuoCustomerIntent,
  resolveCallbackParent,
  type EventDescriptionMessage,
  type QuoCallbackParent,
  type QuoCustomerIntentLabel,
  type SchedulingDirective,
  type StubPhotoAttachment,
} from '@aac/scheduling';
import {
  getQbCustomerIdFromPipedrive,
  logHealthError,
  SCHEDULING_AUTO_PROPOSE_THRESHOLD,
  storePipedriveToQbMapping,
  trackSchedulingClassification,
  writePendingDirective,
} from './redis.js';

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
  /** Used to fetch recent conversation history as classifier context. */
  quo: QuoClient;
  /**
   * Stub-event execution config. When absent or disabled, directives only
   * flow to the shadow queue (pre-stub behavior).
   */
  stub?: {
    enabled: boolean;
    /** Attendees added to stub events without notification (Mike). */
    technicianEmails: string[];
    /**
     * Drive client for uploading customer MMS photos as event
     * attachments. Absent (e.g. missing Google creds) = stubs are
     * created without photos.
     */
    drive?: GoogleDriveClient | null;
  };
  now?: () => Date;
}

export interface SchedulingDispatchSummary {
  classified: number;
  intentsDetected: number;
  directivesWritten: number;
  callbackParentMisses: number;
  stubsCreated: number;
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
    stubsCreated: 0,
    errors: 0,
  };

  const inputs = extractClassifierInputs(context);
  if (inputs.length === 0) return summary;

  const now = deps.now ?? (() => new Date());

  // Conversation context lets the classifier resolve anaphora ("Yes, that
  // works" → the slot Matt offered two messages back). Soft dependency:
  // a failed fetch degrades to context-free classification, never throws.
  const conversationContext = await fetchConversationContext(deps.quo, context);

  const settled = await Promise.allSettled(
    inputs.map(async (input) => {
      const classification = await deps.gemini.classifySchedulingIntent(input.text, {
        speakerRole: input.speakerRole,
        now: now(),
        timezone: DEFAULT_TIMEZONE,
        ...(conversationContext ? { conversationContext } : {}),
      });
      return { input, classification };
    }),
  );

  for (const result of settled) {
    if (result.status === 'rejected') {
      summary.errors++;
      // Soft failure: classifier could not produce an intent (Gemini malformed
      // JSON, transient error, etc.). We degrade gracefully — no directive,
      // no caller-facing impact. Log for observability but do NOT page Matt
      // (the error-surface SMS channel is reserved for real system failures).
      log.error('Classifier failed for one input', result.reason as Error, {
        eventId: context.eventId,
      });
      // Exception: api_error means the request itself is broken (retired
      // model, invalid config, revoked key) — that IS a system failure, and
      // it fails every future classification identically. Surface it so a
      // dead model can't stay silent for weeks (gemini-2.5-flash retirement,
      // Aug 2026).
      const reason = result.reason instanceof ExtractionError ? result.reason.reason : null;
      if (reason === 'api_error') {
        await logHealthError(
          'scheduling-dispatch',
          `Gemini classifier api_error: ${(result.reason as Error).message.substring(0, 200)}`,
          { eventId: context.eventId },
        );
      }
      continue;
    }

    summary.classified++;

    const { input, classification } = result.value;
    if (!GeminiClient.hasSchedulingIntent(classification)) continue;
    summary.intentsDetected++;

    try {
      const directive = await buildDirective(deps, context, input, classification!, now);
      if (!directive) {
        // The most common reason: callback_opened without a resolvable parent.
        // This is a business-data outcome (we couldn't find the original
        // deal), not a system error — don't page Matt via the error-surface
        // SMS. Count it; future "directive queue review" surface can show it.
        if (classification!.intent === 'callback_opened') {
          summary.callbackParentMisses++;
          log.warn('Callback intent detected but parent deal could not be resolved', {
            eventId: context.eventId,
            customerPhone: context.customerPhone,
            pdPersonId: String(context.pdPersonId),
          });
        }
        continue;
      }

      await writePendingDirective(directive);
      summary.directivesWritten++;
      const queue =
        directive.confidence.score >= SCHEDULING_AUTO_PROPOSE_THRESHOLD
          ? 'pending'
          : 'pending-review';
      log.info('Scheduling directive written', {
        directiveId: directive.id,
        intent: directive.intent,
        source: directive.source,
        confidence: directive.confidence.score,
        queue,
      });

      // Stub execution (Walk #7-lite): a directive carrying an AGREED slot
      // (Matt declared the booking, or the customer confirmed an offered
      // time) materializes as a STUB calendar event — title-prefixed, no
      // attendee email, one tap to delete. Gated on the env flag + the
      // same confidence threshold as the auto-propose queue.
      if (
        deps.stub?.enabled
        && queue === 'pending'
        && getActionableSlot(directive) !== null
      ) {
        const created = await createStubForDirective(deps, context, directive);
        if (created) summary.stubsCreated++;
      }
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

/** Max prior messages / transcript lines fed to the classifier as context. */
const MAX_CONTEXT_LINES = 12;

/**
 * Build the classifier's conversation-context block, oldest first, one
 * line per message ("MATT: …" / "CUSTOMER: …").
 *
 * - Transcripts carry their own context: the interleaved dialogue.
 * - Messages fetch the recent thread from Quo. The triggering message is
 *   excluded when it's the newest row (it's already the text being
 *   classified).
 *
 * Never throws — context is an accuracy enhancer, not a dependency.
 */
export async function fetchConversationContext(
  quo: QuoClient,
  context: SchedulingDispatchContext,
): Promise<string | null> {
  if (context.eventType === 'call.transcript.completed') {
    const dialogue = context.dialogue ?? [];
    if (dialogue.length === 0) return null;
    return dialogue
      .slice(-MAX_CONTEXT_LINES)
      .map((d) => `${d.isMatt ? 'MATT' : 'CUSTOMER'}: ${d.content}`)
      .join('\n');
  }

  try {
    const page = await quo.listMessages({
      participantE164: context.customerPhone,
      maxResults: MAX_CONTEXT_LINES + 1,
    });
    const ascending = [...page.data].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    // Drop the triggering message when it's the newest row.
    const newest = ascending[ascending.length - 1];
    const trimmed =
      newest && context.text && newest.text === context.text
        ? ascending.slice(0, -1)
        : ascending;
    if (trimmed.length === 0) return null;
    return trimmed
      .slice(-MAX_CONTEXT_LINES)
      .map((m) => `${m.direction === 'outgoing' ? 'MATT' : 'CUSTOMER'}: ${m.text}`)
      .join('\n');
  } catch (err) {
    log.warn('Conversation-context fetch failed — classifying without context', {
      customerPhone: context.customerPhone,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Recent thread messages in the shape buildEventDescription wants,
 * oldest first. Never throws — description context is a nice-to-have.
 */
async function fetchStubConversationHistory(
  quo: QuoClient,
  customerPhone: string,
): Promise<EventDescriptionMessage[]> {
  try {
    const page = await quo.listMessages({
      participantE164: customerPhone,
      maxResults: 20,
    });
    return [...(page.data ?? [])]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ direction: m.direction, text: m.text ?? '', at: m.createdAt }));
  } catch (err) {
    log.warn('Stub conversation-history fetch failed — building description without it', {
      customerPhone,
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Create the STUB calendar event for a directive with an agreed slot.
 * Self-contained error handling: a stub failure is logged + surfaced to
 * /health but never disturbs the already-written directive or the webhook.
 *
 * The event body is written in Matt's calendar voice (buildEventDescription,
 * which falls back to the raw scopeSummary template internally), and the
 * customer's recent MMS photos are attached via Drive when a drive client
 * is configured. Both are nice-to-haves: any enrichment failure still
 * produces the plain stub.
 */
async function createStubForDirective(
  deps: SchedulingDispatchDeps,
  context: SchedulingDispatchContext,
  directive: SchedulingDirective,
): Promise<boolean> {
  try {
    const now = deps.now ?? (() => new Date());
    const info = await fetchPdPersonInfo(deps.pd, context.pdPersonId);
    const customerName = info.name ?? `PD ${context.pdPersonId}`;
    const technicianEmails = deps.stub?.technicianEmails ?? [];

    let attachments: StubPhotoAttachment[] = [];
    if (deps.stub?.drive) {
      attachments = await collectStubPhotoAttachments(
        { quo: deps.quo, drive: deps.stub.drive, now },
        {
          customerPhone: context.customerPhone,
          shareWithEmails: technicianEmails,
        },
      );
    }

    let description: string | undefined;
    try {
      const built = await buildEventDescription(
        { gemini: deps.gemini, now },
        {
          directive,
          customer: { name: customerName, address: info.address ?? null },
          conversationHistory: await fetchStubConversationHistory(
            deps.quo,
            context.customerPhone,
          ),
          photoCount: attachments.length,
        },
      );
      description = built.description;
      if (built.usedFallback) {
        log.warn('Stub description used template fallback', {
          directiveId: directive.id,
          qualityFlags: built.qualityFlags,
        });
      }
    } catch (err) {
      log.warn('Stub description build threw — falling back to scopeSummary', {
        directiveId: directive.id,
        error: (err as Error).message,
      });
    }

    const result = await executeStubEvent(
      { cal: deps.cal, now },
      {
        directive,
        customerName,
        customerAddress: info.address,
        technicianEmails,
        ...(description ? { description } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    );
    if (result.status === 'created') {
      log.info('Stub calendar event created from directive', {
        directiveId: directive.id,
        eventId: result.eventId,
        intent: directive.intent,
        eventClass: directive.eventClass,
      });
      return true;
    }
    log.info('Stub creation skipped', {
      directiveId: directive.id,
      reason: result.reason,
    });
    return false;
  } catch (err) {
    log.error('Stub creation failed', err as Error, { directiveId: directive.id });
    await logHealthError(
      'scheduling-dispatch',
      `Stub creation failed: ${(err as Error).message.substring(0, 200)}`,
      { directiveId: directive.id },
    );
    return false;
  }
}

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
        ...(classification.slotCommitment
          ? { slotCommitment: classification.slotCommitment }
          : {}),
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
    && classification.intent !== 'appointment_confirmed'
  ) {
    return null;
  }

  if (classification.intent === 'appointment_confirmed') {
    // A confirmation without a resolvable slot can't drive anything —
    // treat like no intent (the classifier is told to require one).
    if (!classification.knownSlot) {
      log.warn('appointment_confirmed without a resolvable slot — dropped', {
        eventId: context.eventId,
        pdPersonId: context.pdPersonId,
      });
      return null;
    }
    const info = await fetchPdPersonInfo(deps.pd, context.pdPersonId);
    return normalizeAppointmentConfirmed(normalizerDeps, {
      classification: {
        score: classification.score,
        knownSlot: classification.knownSlot,
        ...(classification.eventClass ? { eventClass: classification.eventClass } : {}),
        scopeSummary: classification.scopeSummary,
      },
      customer: {
        customerPhone: context.customerPhone,
        pdPersonId: context.pdPersonId,
        ...(info.qbCustomerId ? { qbCustomerId: info.qbCustomerId } : {}),
      },
      source: source as 'quo_text' | 'quo_call',
    });
  }

  const personInfo = await fetchPdPersonInfo(deps.pd, context.pdPersonId);
  const customerName = personInfo.name;

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
      ...(personInfo.qbCustomerId ? { qbCustomerId: personInfo.qbCustomerId } : {}),
    },
    source: source as 'quo_text' | 'quo_call',
    ...(callbackParent ? { callbackParent } : {}),
  });
}

/**
 * Read PD person info needed for directive normalization:
 *   - display name (for scope summary + callback-parent lookup)
 *   - linked QB customer id (so the directive carries the cross-system ref
 *     and downstream consumers — proposal-builder address lookup,
 *     executeDirective — don't have to re-derive it)
 *
 * The QB id is read from Redis cache first (set by the PD-create webhook
 * path); on miss we fall through to PD's custom-field read and warm the
 * cache on success. Single `getPerson` call serves both the name and the
 * cache-miss field read.
 */
async function fetchPdPersonInfo(
  pd: PipedriveClient,
  pdPersonId: number,
): Promise<{ name: string | null; qbCustomerId: string | null; address: string | null }> {
  let person: PipedrivePerson | null = null;
  try {
    person = await pd.getPerson(pdPersonId);
  } catch (err) {
    log.warn('PD getPerson failed during scheduling dispatch', {
      pdPersonId,
      error: (err as Error).message,
    });
    return { name: null, qbCustomerId: null, address: null };
  }

  const name = person?.name ?? null;
  const rawPerson = person as unknown as Record<string, unknown> | null;
  const rawAddress = rawPerson?.[PIPEDRIVE_CROSS_SYSTEM_FIELDS.PERSONAL_ADDRESS];
  const address = typeof rawAddress === 'string' && rawAddress.length > 0 ? rawAddress : null;

  const cachedQbId = await getQbCustomerIdFromPipedrive(String(pdPersonId));
  if (cachedQbId) return { name, qbCustomerId: cachedQbId, address };

  const rawField = rawPerson?.[PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID];
  const qbCustomerId = typeof rawField === 'string' && rawField.length > 0 ? rawField : null;
  if (qbCustomerId) {
    await storePipedriveToQbMapping(String(pdPersonId), qbCustomerId);
  }
  return { name, qbCustomerId, address };
}

