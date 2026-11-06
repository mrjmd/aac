/**
 * AI entity extraction for Quo events: pull name / email / address out of
 * inbound texts and caller transcript lines, and fill the PD person in.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { GeminiClient, ExtractionError } from '@aac/api-clients/gemini';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import { logHealthError } from '../redis.js';
import { getGemini } from '../clients.js';
import { extractTextForAI, shouldProcessForAI } from './event-content.js';
import type { QuoEvent, QuoEventData } from './types.js';

const log = createLogger('quo-webhook');

/**
 * Run extraction when the event qualifies and update the PD person
 * incrementally. Failures are logged and surfaced to /api/health, never
 * thrown.
 */
export async function extractAndApplyEntities(
  pd: PipedriveClient,
  event: QuoEvent,
  eventData: QuoEventData,
  pipedrivePersonId: number,
  e164Phone: string,
): Promise<void> {
  if (shouldProcessForAI(event.type, eventData)) {
    const textContent = extractTextForAI(eventData);
    log.info('Processing for AI entity extraction', {
      personId: pipedrivePersonId,
      type: event.type,
      textLength: textContent.length,
    });

    try {
      const gemini = getGemini();
      const entities = await gemini.extractEntities(textContent);

      if (GeminiClient.hasUsefulEntities(entities)) {
        let extractedName: string | undefined;
        if (entities!.fullName) {
          extractedName = entities!.fullName;
        } else if (entities!.firstName && entities!.lastName) {
          extractedName = `${entities!.firstName} ${entities!.lastName}`;
        } else if (entities!.firstName) {
          extractedName = entities!.firstName;
        } else if (entities!.lastName) {
          extractedName = entities!.lastName;
        }

        const updateResult = await pd.updatePersonIncremental(pipedrivePersonId, {
          name: extractedName,
          phone: e164Phone,
          email: entities!.email || undefined,
          address: entities!.streetAddress || undefined,
          city: entities!.city || undefined,
          state: entities!.state || undefined,
          zipCode: entities!.zipCode || undefined,
        });

        if (updateResult.updated) {
          log.info('AI extracted and updated contact', {
            personId: pipedrivePersonId,
            fields: updateResult.fields,
            confidence: entities!.confidence,
          });
        }
      }
    } catch (error) {
      const reason = error instanceof ExtractionError ? error.reason : 'unknown';
      log.error('AI entity extraction failed', error as Error, {
        personId: pipedrivePersonId,
        reason,
      });
      // Surface to error-surface — if extraction is failing in production
      // Matt needs to know so we can fix the root cause (not silence it).
      // The agent-side dedup keeps recurring failures from spamming him.
      await logHealthError('quo', `AI extraction failed (${reason}): ${(error as Error).message.substring(0, 200)}`, {
        personId: String(pipedrivePersonId),
        reason,
        eventType: event.type,
      });
    }
  }
}
