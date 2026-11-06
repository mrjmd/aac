/**
 * Read what the Quo and QuickBooks syncs need from a Pipedrive person:
 * primary phone, name split, company, job title, email and address.
 */

import { QuoClient } from '@aac/api-clients/quo';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { PersonSyncData, PipedrivePersonPayload } from './types.js';

// Pipedrive custom field keys
const PIPEDRIVE_FIELDS = {
  JOB_TITLE: '6483bb4aaf895975a61ec08210d17978769a8e85',
} as const;

/**
 * Extract primary phone from Pipedrive person data
 */
export function extractPrimaryPhone(
  phones: Array<{ value: string; primary: boolean; label: string }> | undefined
): string | null {
  if (!phones || phones.length === 0) return null;
  const primary = phones.find((p) => p.primary);
  return primary?.value || phones[0]?.value || null;
}

/**
 * Fetch the person data shared by both syncs. Makes at most one
 * getOrganization and one getPerson call.
 */
export async function loadPersonSyncData(
  pd: PipedriveClient,
  data: PipedrivePersonPayload,
): Promise<PersonSyncData> {
  const personName = data.name || 'Unknown';
  const { firstName, lastName } = QuoClient.parseFullName(personName);

  // Get company name - either from webhook payload or fetch from API
  let company: string | undefined = data.org_name || undefined;
  if (!company && data.org_id) {
    const org = await pd.getOrganization(data.org_id);
    company = org?.name || undefined;
  }

  // Fetch full person data once (used by both Quo sync for job title and QB sync for address)
  let jobTitle: string | undefined = (data[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined;
  const fullPerson = !jobTitle || data.org_id
    ? (await pd.getPerson(data.id)) as Record<string, unknown> | null
    : null;
  if (!jobTitle && fullPerson) {
    jobTitle = (fullPerson[PIPEDRIVE_FIELDS.JOB_TITLE] as string) || undefined;
  }

  // Extract email (shared by Quo and QB sync)
  const emails = data.emails as
    | Array<{ value: string; primary: boolean; label: string }>
    | undefined;
  const primaryEmail = emails?.find((e) => e.primary)?.value || emails?.[0]?.value;

  // Extract address from Pipedrive custom field (shared by Quo and QB sync)
  const addressField = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';
  const streetNumber = fullPerson?.[`${addressField}_street_number`] as string | undefined;
  const route = fullPerson?.[`${addressField}_route`] as string | undefined;
  const locality = fullPerson?.[`${addressField}_locality`] as string | undefined;
  const state = fullPerson?.[`${addressField}_admin_area_level_1`] as string | undefined;
  const postalCode = fullPerson?.[`${addressField}_postal_code`] as string | undefined;
  const addressLine1 =
    streetNumber && route
      ? `${streetNumber} ${route}`
      : (fullPerson?.[addressField] as string | undefined);
  const formattedAddress = addressLine1
    ? [addressLine1, locality, state, postalCode].filter(Boolean).join(', ')
    : undefined;

  return {
    personName,
    firstName,
    lastName,
    company,
    jobTitle,
    primaryEmail,
    addressLine1,
    locality,
    state,
    postalCode,
    formattedAddress,
  };
}
