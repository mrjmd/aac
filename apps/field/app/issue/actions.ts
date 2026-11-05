'use server';

import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { normalizePhone } from '@aac/shared-utils/phone';
import { getCalendar, getPipedrive, getQuo } from '@/lib/clients';
import { matchEventToPerson } from '@/lib/customer-match';
import { requireSession } from '@/lib/session';

const ALLOWED_MINUTES = new Set([5, 10, 15]);

export type SendLateTextResult =
  | { ok: true; minutes: number; toName: string }
  | { ok: false; error: string };

/**
 * Server-side handler for the "Running X min late" buttons on /issue.
 *
 * Trust nothing the client passed except (a) which event to text and (b)
 * how many minutes. The phone number is re-resolved server-side from PD
 * so a tampered client can't redirect the message to an arbitrary number.
 */
export async function sendRunningLateText(
  eventId: string,
  minutes: number,
): Promise<SendLateTextResult> {
  const session = await requireSession();

  if (!ALLOWED_MINUTES.has(minutes)) {
    return { ok: false, error: `Invalid minutes value: ${minutes}` };
  }

  let evt;
  try {
    evt = await getCalendar().getEvent(eventId);
  } catch (err) {
    console.error('running-late: failed to load event', eventId, err);
    return { ok: false, error: "Couldn't load that event." };
  }

  const person = await matchEventToPerson(evt, getPipedrive()).catch((err) => {
    console.error('running-late: PD lookup failed', eventId, err);
    return null;
  });
  if (!person) {
    return { ok: false, error: 'No matching customer in Pipedrive.' };
  }

  const rawPhone = PipedriveClient.getPrimaryPhone(person);
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (!phone) {
    return { ok: false, error: 'No phone on file for this customer.' };
  }

  const techFirstName = session.name.trim().split(/\s+/)[0] || '';
  const techPhrase = techFirstName ? `our technician ${techFirstName}` : 'our technician';
  const text = `Hey just a heads up, ${techPhrase} is on his way, but is running slightly behind schedule. Looks like he will be about ${minutes} minutes late. Let me know if you have any concerns.`;

  try {
    await getQuo().sendMessage(phone, text);
  } catch (err) {
    console.error('running-late: SMS send failed', { eventId, phone, err });
    return { ok: false, error: "Couldn't send the text. Try calling Matt." };
  }

  return { ok: true, minutes, toName: person.name || 'customer' };
}
