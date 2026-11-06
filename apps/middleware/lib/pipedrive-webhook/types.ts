/**
 * Pipedrive webhook payload types, shared by the handler in
 * api/webhooks/pipedrive.ts and the per-concern modules beside this file.
 */

import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';

// Pipedrive webhook payload structure
export interface PipedriveWebhookPayload {
  meta: {
    action: 'added' | 'updated' | 'deleted';
    change_source: string;
    company_id: number;
    host: string;
    id: number;
    object: string;
    timestamp: number;
    user_id: number;
    webhook_id: string;
    [key: string]: unknown;
  };
  data: {
    id: number;
    name: string;
    first_name: string;
    last_name: string;
    phones: Array<{ value: string; primary: boolean; label: string }>;
    emails: Array<{ value: string; primary: boolean; label: string }>;
    org_id: number | null;
    org_name: string | null;
    owner_id: number;
    [key: string]: unknown;
  } | null;
  previous: {
    [key: string]: unknown;
  } | null;
}

/** The person in a validated payload (payload.data, non-null). */
export type PipedrivePersonPayload = NonNullable<PipedriveWebhookPayload['data']>;

/** Person fields fetched once and shared by the Quo and QuickBooks syncs. */
export interface PersonSyncData {
  personName: string;
  firstName: string;
  lastName: string | null;
  company: string | undefined;
  jobTitle: string | undefined;
  primaryEmail: string | undefined;
  addressLine1: string | undefined;
  locality: string | undefined;
  state: string | undefined;
  postalCode: string | undefined;
  formattedAddress: string | undefined;
}

/** Everything one person sync needs: the payload person, phone, clients and fetched data. */
export interface PersonSyncContext {
  data: PipedrivePersonPayload;
  e164Phone: string;
  pd: PipedriveClient;
  quo: QuoClient;
  qb: QuickBooksClient;
  person: PersonSyncData;
}
