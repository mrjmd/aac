/**
 * Manual Re-Enrich Endpoint
 *
 * GET /api/enrich?personId=5446
 *
 * Fetches the person's recent activities (transcripts, SMS), runs AI entity
 * extraction, and updates the Pipedrive person. Useful for retrying contacts
 * where extraction failed due to rate limits or transient errors.
 *
 * No auth required — this only reads activities and updates contact info,
 * same as the automatic webhook flow. Idempotent (safe to call multiple times).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { GeminiClient, ExtractionError } from '@aac/api-clients/gemini';
import { getPipedrive, getGemini } from '../lib/clients.js';

const log = createLogger('enrich');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const personId = parseInt(req.query.personId as string, 10);
  if (!personId || isNaN(personId)) {
    return res.status(400).json({ error: 'Missing or invalid personId parameter' });
  }

  const pd = getPipedrive();

  try {
    // Fetch the person
    const person = await pd.getPerson(personId);
    if (!person) {
      return res.status(404).json({ error: 'Person not found', personId });
    }

    log.info('Re-enrich requested', { personId, currentName: person.name });

    // Fetch recent activities for this person
    const activities = await pd.getPersonActivities(personId, { limit: 20 });

    // Collect text from transcripts and inbound SMS
    const textSources: Array<{ type: string; text: string }> = [];

    for (const activity of activities) {
      const note = activity.note || '';
      const subject = activity.subject || '';

      if (subject.includes('Transcript') && note.includes('Caller:')) {
        // Extract caller lines from transcript
        const callerLines = note
          .split('\n')
          .filter((l: string) => l.startsWith('Caller:'))
          .map((l: string) => l.replace('Caller: ', ''));
        if (callerLines.length > 0) {
          textSources.push({ type: 'transcript', text: callerLines.join(' ') });
        }
      } else if (subject.includes('SMS Received')) {
        // Extract SMS body
        const bodyMatch = note.match(/Full message:\s*\n\n([\s\S]*?)(\n\nLine:|$)/);
        if (bodyMatch?.[1]?.trim()) {
          textSources.push({ type: 'sms', text: bodyMatch[1].trim() });
        }
      }
    }

    if (textSources.length === 0) {
      return res.status(200).json({
        status: 'no_content',
        personId,
        message: 'No transcripts or inbound SMS found to extract from',
      });
    }

    // Concatenate all text sources for extraction
    const allText = textSources.map((s) => s.text).join('\n\n');
    log.info('Extracting from activities', {
      personId,
      sources: textSources.map((s) => s.type),
      textLength: allText.length,
    });

    // Run extraction
    const gemini = getGemini();
    const entities = await gemini.extractEntities(allText);

    if (!GeminiClient.hasUsefulEntities(entities)) {
      return res.status(200).json({
        status: 'no_entities',
        personId,
        message: 'AI extraction found no useful contact info',
        textSources: textSources.map((s) => ({ type: s.type, length: s.text.length })),
      });
    }

    // Build name from entities
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

    // Apply incremental update
    const updateResult = await pd.updatePersonIncremental(personId, {
      name: extractedName,
      email: entities!.email || undefined,
      address: entities!.streetAddress || undefined,
      city: entities!.city || undefined,
      state: entities!.state || undefined,
      zipCode: entities!.zipCode || undefined,
    });

    log.info('Re-enrich complete', {
      personId,
      updated: updateResult.updated,
      fields: updateResult.fields,
    });

    return res.status(200).json({
      status: updateResult.updated ? 'enriched' : 'no_update_needed',
      personId,
      extracted: {
        name: extractedName,
        email: entities!.email,
        address: entities!.streetAddress,
        city: entities!.city,
        state: entities!.state,
        zipCode: entities!.zipCode,
        confidence: entities!.confidence,
      },
      updatedFields: updateResult.fields,
    });
  } catch (error) {
    const reason = error instanceof ExtractionError ? error.reason : 'unknown';
    log.error('Re-enrich failed', error as Error, { personId, reason });

    return res.status(500).json({
      status: 'error',
      personId,
      reason,
      message: (error as Error).message,
    });
  }
}
