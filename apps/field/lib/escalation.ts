/**
 * Resolve a technician's escalation target — who to call/text when something
 * needs a human higher up the chain.
 *
 * Today this is hardcoded to a single env-configured target (the AAC owner)
 * because there's exactly one tech. The shape is forward-compatible with the
 * org-chart future-state described in docs/projects/apps-field.md: when we
 * have multiple techs and multiple roles (owner, ops manager, dispatcher,
 * AI triage), this function grows into a real lookup keyed by the session's
 * email + the issue type. Callers should keep treating the result as opaque.
 */

import type { FieldSession } from './session';
import { getEnv } from './env';

export interface EscalationTarget {
  /** First name only — what shows up in CTAs like "Call Matt". */
  name: string;
  /** E.164 phone number for tel:/sms: links. */
  phoneE164: string;
}

export function getEscalationTarget(_session: FieldSession): EscalationTarget {
  const env = getEnv();
  return {
    name: env.escalation.name,
    phoneE164: env.notifications.alertPhoneNumber,
  };
}
