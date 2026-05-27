/**
 * Quo (OpenPhone) API client — Contact management and SMS sending.
 *
 * Extracted from aac-slim/src/clients/quo.ts.
 * Refactored to class pattern with constructor config (no process.env reads).
 *
 * Stripped: hasExistingConversation, getPhoneNumberId (campaign dedup only).
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('quo');

const QUO_API_BASE = 'https://api.openphone.com/v1';

// ── Interfaces ───────────────────────────────────────────────────────

export interface QuoConfig {
  apiKey: string;
  phoneNumber: string;
  webhookSecret?: string;
}

export interface QuoContact {
  id: string;
  externalId?: string | null;
  source?: string | null;
  defaultFields: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    emails: Array<{ value: string; name?: string; id?: string }>;
    phoneNumbers: Array<{ value: string; name?: string; id?: string }>;
    role: string | null;
  };
  customFields?: Array<{ key: string; value: unknown }>;
  createdAt: string;
  updatedAt: string;
}

// Quo rejects these source values on PATCH (system-reserved). When a
// contact's existing source matches, we omit `source` from the PATCH
// body entirely so Quo preserves its own value.
const RESERVED_SOURCE_VALUES = new Set(['csv', 'device', 'openphone', 'other', 'zapier', 'google-people']);
const RESERVED_SOURCE_PREFIXES = ['openphone', 'csv'];
function isReservedSource(s: string | null | undefined): boolean {
  if (!s) return false;
  const lower = s.toLowerCase();
  if (RESERVED_SOURCE_VALUES.has(lower)) return true;
  return RESERVED_SOURCE_PREFIXES.some(p => lower.startsWith(p));
}

export interface QuoCustomFieldValue {
  key: string;
  value: string | number | boolean | string[] | null;
}

export interface QuoCustomFieldDefinition {
  name: string;
  key: string;
  type: 'address' | 'boolean' | 'date' | 'multi-select' | 'number' | 'string' | 'url';
}

export interface QuoContactCreate {
  defaultFields: {
    firstName?: string;
    lastName?: string;
    company?: string;
    role?: string;
    emails?: Array<{ value: string; name: string }>;
    phoneNumbers: Array<{ value: string; name: string }>;
  };
  customFields?: QuoCustomFieldValue[];
  // Quo lets external systems set their own ID + source. We use externalId =
  // E.164 phone so future lookups can use the fast ?externalIds[]= query
  // instead of paginating every contact. See findContactByExternalId.
  externalId?: string;
  source?: string;
}

// ── Client ───────────────────────────────────────────────────────────

export class QuoClient {
  private cachedCustomFields: QuoCustomFieldDefinition[] | null = null;

  constructor(private config: QuoConfig) {}

  // ── Private request helper ──────────────────────────────────────

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${QUO_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': this.config.apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('Quo API error', new Error(error), {
        endpoint,
        status: response.status,
      });
      throw new Error(`Quo API error: ${response.status} - ${error}`);
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json();
    return data as T;
  }

  // ── Contact CRUD ────────────────────────────────────────────────

  /**
   * O(1) lookup using Quo's externalId index. Returns the contact whose
   * externalId matches (we use E.164 phone), or null. Single API call, no
   * pagination. Prefer this over searchContactByPhone whenever possible.
   */
  async findContactByExternalId(externalId: string): Promise<QuoContact | null> {
    const params = new URLSearchParams({ maxResults: '50' });
    params.append('externalIds[]', externalId);

    const result = await this.request<{ data: QuoContact[] }>(`/contacts?${params.toString()}`);
    const match = result.data?.[0] ?? null;
    if (match) {
      log.debug('Found contact by externalId', { externalId, contactId: match.id });
    }
    return match;
  }

  /**
   * Linear scan of every Quo contact, filtering client-side because Quo's
   * /v1/contacts endpoint does not accept a phone filter. O(N) in total
   * contacts and gets slower as the contact list grows. Use this only as
   * a fallback for contacts created before we started setting externalId
   * on every create. The internal AbortController guards against the
   * Vercel 30s function timeout by failing fast at 15s — a thrown error
   * surfaces in logHealthError instead of getting silently killed.
   */
  async searchContactByPhone(phone: string): Promise<QuoContact | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      let pageToken: string | undefined;

      do {
        const params = new URLSearchParams({ maxResults: '50' });
        if (pageToken) params.set('pageToken', pageToken);

        let result: { data: QuoContact[]; nextPageToken?: string };
        try {
          result = await this.request<{ data: QuoContact[]; nextPageToken?: string }>(
            `/contacts?${params.toString()}`,
            { signal: controller.signal }
          );
        } catch (pageError) {
          if (controller.signal.aborted) {
            throw new Error(
              `searchContactByPhone timeout (15s) — too many Quo contacts to scan. ` +
              `Set externalId on contact create so findContactByExternalId can be used.`
            );
          }
          log.warn('Contacts page failed, skipping', { pageToken, error: (pageError as Error).message });
          break;
        }

        const match = result.data?.find((contact) => {
          const phones = contact.defaultFields?.phoneNumbers || [];
          return phones.some((p) => p.value === phone);
        });

        if (match) {
          log.debug('Found contact by phone', { phone, contactId: match.id });
          return match;
        }

        pageToken = result.nextPageToken;
      } while (pageToken);

      log.debug('No contact found for phone', { phone });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fast lookup-by-phone with safe fallback. Tries externalId first (O(1)),
   * falls back to the slow linear scan if that misses — covers legacy
   * contacts created before we started setting externalId.
   */
  async findContactByPhone(phone: string): Promise<QuoContact | null> {
    const byExternal = await this.findContactByExternalId(phone);
    if (byExternal) return byExternal;
    return this.searchContactByPhone(phone);
  }

  async getContact(id: string): Promise<QuoContact | null> {
    try {
      const result = await this.request<{ data: QuoContact }>(`/contacts/${id}`);
      return result.data;
    } catch (error) {
      log.error('Get contact failed', error as Error, { contactId: id });
      return null;
    }
  }

  async createContact(contact: QuoContactCreate): Promise<QuoContact> {
    log.info('Creating contact', {
      firstName: contact.defaultFields.firstName,
      lastName: contact.defaultFields.lastName,
      phone: contact.defaultFields.phoneNumbers[0]?.value,
    });

    const result = await this.request<{ data: QuoContact }>('/contacts', {
      method: 'POST',
      body: JSON.stringify(contact),
    });

    log.info('Created contact', { contactId: result.data.id });
    return result.data;
  }

  /**
   * Update an existing contact.
   *
   * IMPORTANT: Quo's PATCH API replaces the entire contact state, not
   * just the fields you send — any field omitted from the body gets
   * cleared (or in the case of nested arrays, emptied). We read-merge-
   * write the full contact to avoid data loss.
   *
   * That includes the top-level `externalId` and `source` fields, which
   * Quo also wipes when omitted. Pass `externalId: null` to explicitly
   * clear it; omit the key to preserve the current value. Reserved
   * source values (openphone, csv, etc.) are omitted from the PATCH
   * body because Quo rejects them; Quo preserves the existing value in
   * that case.
   */
  async updateContact(
    id: string,
    updates: {
      defaultFields?: Partial<QuoContactCreate['defaultFields']>;
      customFields?: QuoCustomFieldValue[];
      externalId?: string | null;
      source?: string | null;
    }
  ): Promise<QuoContact> {
    log.info('Updating contact', { contactId: id });

    const current = await this.getContact(id);

    let body: Record<string, unknown>;

    if (current) {
      const currentDefaults = current.defaultFields || {};

      // Quo returns phoneNumbers/emails with an internal `id` field on GET,
      // but rejects the same id on PATCH with "Item with ID … does not match".
      // Strip everything except value/name before echoing back.
      const stripIds = <T extends { value?: string; name?: string }>(items: T[] | undefined) =>
        (items || []).map(({ value, name }) => ({ value, name } as T));

      const mergedDefaults: Record<string, unknown> = {
        firstName: currentDefaults.firstName,
        lastName: currentDefaults.lastName,
        company: currentDefaults.company,
        role: currentDefaults.role,
        phoneNumbers: stripIds(currentDefaults.phoneNumbers),
        emails: stripIds(currentDefaults.emails),
      };

      if (updates.defaultFields) {
        for (const [key, value] of Object.entries(updates.defaultFields)) {
          if (value !== undefined) {
            mergedDefaults[key] = value;
          }
        }
      }

      const existingCustom = current.customFields || [];
      const mergedCustom = [...existingCustom];
      if (updates.customFields) {
        for (const update of updates.customFields) {
          const idx = mergedCustom.findIndex(f => f.key === update.key);
          if (idx >= 0) {
            mergedCustom[idx] = update;
          } else {
            mergedCustom.push(update);
          }
        }
      }

      body = { defaultFields: mergedDefaults };
      if (mergedCustom.length > 0) {
        body.customFields = mergedCustom;
      }

      // externalId: explicit update wins, else preserve current
      const nextExternalId = updates.externalId !== undefined ? updates.externalId : current.externalId;
      if (nextExternalId !== undefined && nextExternalId !== null) {
        body.externalId = nextExternalId;
      } else if (updates.externalId === null) {
        body.externalId = null;
      }

      // source: explicit update wins (subject to reserved-value omit), else preserve current
      const nextSource = updates.source !== undefined ? updates.source : current.source;
      if (nextSource && !isReservedSource(nextSource)) {
        body.source = nextSource;
      }
    } else {
      log.warn('Cannot read contact for merge, sending partial update', { contactId: id });
      body = {};
      if (updates.defaultFields) body.defaultFields = updates.defaultFields;
      if (updates.customFields) body.customFields = updates.customFields;
      if (updates.externalId !== undefined) body.externalId = updates.externalId;
      if (updates.source !== undefined && !isReservedSource(updates.source)) body.source = updates.source;
    }

    const result = await this.request<{ data: QuoContact }>(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    log.info('Updated contact', { contactId: result.data.id });
    return result.data;
  }

  async deleteContact(id: string): Promise<void> {
    log.info('Deleting contact', { contactId: id });
    await this.request(`/contacts/${id}`, { method: 'DELETE' });
    log.info('Deleted contact', { contactId: id });
  }

  // ── Custom fields ───────────────────────────────────────────────

  async getCustomFields(): Promise<QuoCustomFieldDefinition[]> {
    if (this.cachedCustomFields) {
      return this.cachedCustomFields;
    }

    const result = await this.request<{ data: QuoCustomFieldDefinition[] }>('/contact-custom-fields');
    this.cachedCustomFields = result.data || [];
    log.debug('Fetched custom field definitions', { count: this.cachedCustomFields.length });
    return this.cachedCustomFields;
  }

  async getCustomFieldKey(fieldName: string): Promise<string | null> {
    const fields = await this.getCustomFields();
    const match = fields.find(f => f.name.toLowerCase() === fieldName.toLowerCase());
    return match?.key || null;
  }

  // ── Messaging ───────────────────────────────────────────────────

  /**
   * Send an SMS message via Quo/OpenPhone.
   * @param to - Recipient phone number (E.164 format)
   * @param text - Message content
   * @param from - Optional sender phone number. Defaults to config.phoneNumber.
   */
  async sendMessage(
    to: string,
    text: string,
    from?: string
  ): Promise<{ id: string }> {
    const sender = from || this.config.phoneNumber;
    log.info('Sending SMS', { from: sender, to, textLength: text.length });

    const result = await this.request<{ data: { id: string } }>('/messages', {
      method: 'POST',
      body: JSON.stringify({
        from: sender,
        to: [to],
        content: text,
      }),
    });

    log.info('Sent SMS', { messageId: result.data.id });
    return result.data;
  }

  // ── Static utilities ────────────────────────────────────────────

  static parseFullName(fullName: string): { firstName: string; lastName: string | null } {
    const parts = fullName.trim().split(/\s+/);

    if (parts.length === 0) {
      return { firstName: 'Unknown', lastName: null };
    }

    if (parts.length === 1) {
      return { firstName: parts[0], lastName: null };
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  static getFullName(contact: QuoContact): string {
    const fields = contact.defaultFields;
    const parts = [fields?.firstName, fields?.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'Unknown';
  }

  static getPrimaryPhone(contact: QuoContact): string | null {
    return contact.defaultFields?.phoneNumbers?.[0]?.value || null;
  }
}
