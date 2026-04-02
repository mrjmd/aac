/**
 * Pipedrive CRM client — Person CRUD and activity logging.
 *
 * Extracted from aac-slim/src/clients/pipedrive.ts.
 * Refactored to class pattern with constructor config (no process.env reads).
 *
 * Stripped: createCampaignContact, getPersonReferredBy, getPipedriveUser,
 * getPersonOwnerId (attribution-only methods).
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('pipedrive');

// ── Interfaces ───────────────────────────────────────────────────────

export interface PipedriveConfig {
  apiKey: string;
  companyDomain: string;
  systemUserId?: string;
}

export interface PipedrivePerson {
  id: number;
  name: string;
  phone: Array<{ value: string; primary: boolean }>;
  email: Array<{ value: string; primary: boolean }>;
  org_id?: number;
  owner_id?: {
    id: number;
    name: string;
    email: string;
  };
}

export interface PipedriveOrganization {
  id: number;
  name: string;
  address?: string;
}

export interface PipedriveActivity {
  id: number;
  type: string;
  subject: string;
  person_id: number;
  done: boolean;
  add_time: string;          // "2026-04-01 14:30:00"
  duration: string;          // "00:04:30" (HH:MM:SS)
  note: string | null;
  due_date: string | null;
  due_time: string | null;
}

interface SearchResult {
  items: Array<{
    item: PipedrivePerson;
  }>;
}

/** Custom field keys for storing external system IDs on Pipedrive persons */
export const PIPEDRIVE_CROSS_SYSTEM_FIELDS = {
  QUO_CONTACT_ID: '66f248c11ab22515e0dcd93f0bd9671ba6970fd4',
  QB_CUSTOMER_ID: 'a02e76a3d2d7e38cacd476aaea1c2a8809264025',
} as const;

// ── Client ───────────────────────────────────────────────────────────

export class PipedriveClient {
  constructor(private config: PipedriveConfig) {}

  // ── Private request helper ──────────────────────────────────────

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const baseUrl = 'https://api.pipedrive.com/v1';
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set('api_token', this.config.apiKey);

    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('Pipedrive API error', new Error(error), {
        endpoint,
        status: response.status,
      });
      throw new Error(`Pipedrive API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.data as T;
  }

  // ── Person CRUD ─────────────────────────────────────────────────

  async searchPersonByPhone(phone: string): Promise<PipedrivePerson | null> {
    try {
      const result = await this.request<SearchResult>(
        `/persons/search?term=${encodeURIComponent(phone)}&fields=phone`
      );

      if (result?.items?.length > 0) {
        log.debug('Found person by phone', { phone, personId: result.items[0].item.id });
        return result.items[0].item;
      }

      log.debug('No person found for phone', { phone });
      return null;
    } catch (error) {
      log.error('Search person failed', error as Error, { phone });
      throw error;
    }
  }

  async searchPersonByName(name: string): Promise<PipedrivePerson | null> {
    try {
      const result = await this.request<SearchResult>(
        `/persons/search?term=${encodeURIComponent(name)}&fields=name`
      );

      if (result?.items?.length > 0) {
        return result.items[0].item;
      }

      return null;
    } catch (error) {
      log.error('Search person by name failed', error as Error, { name });
      throw error;
    }
  }

  async getPerson(id: number): Promise<PipedrivePerson | null> {
    try {
      return await this.request<PipedrivePerson>(`/persons/${id}`);
    } catch (error) {
      log.error('Get person failed', error as Error, { personId: id });
      return null;
    }
  }

  async getOrganization(id: number): Promise<PipedriveOrganization | null> {
    try {
      return await this.request<PipedriveOrganization>(`/organizations/${id}`);
    } catch (error) {
      log.error('Get organization failed', error as Error, { orgId: id });
      return null;
    }
  }

  async createPerson(
    name: string,
    phone: string,
    options?: {
      email?: string;
      note?: string;
    }
  ): Promise<PipedrivePerson> {
    log.info('Creating person', { name, phone });

    const body: Record<string, unknown> = {
      name,
      phone: [{ value: phone, primary: true }],
    };

    if (options?.email) {
      body.email = [{ value: options.email, primary: true }];
    }

    const person = await this.request<PipedrivePerson>('/persons', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (options?.note) {
      await this.request('/notes', {
        method: 'POST',
        body: JSON.stringify({
          content: options.note,
          person_id: person.id,
        }),
      });
    }

    log.info('Created person', { personId: person.id, name });
    return person;
  }

  async updatePerson(
    id: number,
    updates: {
      name?: string;
      phone?: string;
      email?: string;
    }
  ): Promise<PipedrivePerson> {
    log.info('Updating person', { personId: id, updates });

    const body: Record<string, unknown> = {};

    if (updates.name) body.name = updates.name;
    if (updates.phone) body.phone = [{ value: updates.phone, primary: true }];
    if (updates.email) body.email = [{ value: updates.email, primary: true }];

    const person = await this.request<PipedrivePerson>(`/persons/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    log.info('Updated person', { personId: person.id });
    return person;
  }

  /**
   * Incrementally update a person — only add new fields, don't overwrite existing.
   * Used by AI Listener to add extracted data without overwriting known good data.
   */
  async updatePersonIncremental(
    id: number,
    updates: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      city?: string;
      state?: string;
      zipCode?: string;
    }
  ): Promise<{ updated: boolean; fields: string[] }> {
    const person = await this.getPerson(id);
    if (!person) {
      log.warn('Cannot update non-existent person', { personId: id });
      return { updated: false, fields: [] };
    }

    const body: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    // Only update name if current name is "Unknown Lead..." pattern
    if (updates.name && person.name.startsWith('Unknown Lead')) {
      body.name = updates.name;
      updatedFields.push('name');
    }

    // Add phone if person has no phone
    const currentPhone = PipedriveClient.getPrimaryPhone(person);
    if (updates.phone && !currentPhone) {
      body.phone = [{ value: updates.phone, primary: true }];
      updatedFields.push('phone');
    }

    // Only add email if person has no email
    const currentEmail = PipedriveClient.getPrimaryEmail(person);
    if (updates.email && !currentEmail) {
      body.email = [{ value: updates.email, primary: true }];
      updatedFields.push('email');
    }

    // Personal address field - custom field with hash key
    const ADDR_KEY = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';

    if (updates.address || updates.city || updates.state || updates.zipCode) {
      if (updates.address) {
        body[`${ADDR_KEY}_route`] = updates.address;
        updatedFields.push('street');
      }
      if (updates.city) {
        body[`${ADDR_KEY}_locality`] = updates.city;
        updatedFields.push('city');
      }
      if (updates.state) {
        body[`${ADDR_KEY}_admin_area_level_1`] = updates.state;
        updatedFields.push('state');
      }
      if (updates.zipCode) {
        body[`${ADDR_KEY}_postal_code`] = updates.zipCode;
        updatedFields.push('zip');
      }

      const addressParts = [
        updates.address,
        updates.city,
        updates.state && updates.zipCode ? `${updates.state} ${updates.zipCode}` : (updates.state || updates.zipCode),
      ].filter(Boolean);

      if (addressParts.length > 0) {
        body[ADDR_KEY] = addressParts.join(', ');
      }
    }

    if (Object.keys(body).length === 0) {
      log.debug('No incremental updates needed', { personId: id });
      return { updated: false, fields: [] };
    }

    log.info('Incremental person update', { personId: id, fields: updatedFields });

    await this.request<PipedrivePerson>(`/persons/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return { updated: true, fields: updatedFields };
  }

  // ── Activity logging ────────────────────────────────────────────

  /**
   * Log a completed activity (call or SMS) on a person.
   *
   * Note: Pipedrive does not have a native 'sms' activity type — it only
   * recognizes 'call'. SMS activities are logged as type 'call' and
   * distinguished by subject prefix ('SMS Received:', 'SMS Sent:').
   *
   * Duration must be provided in seconds; it is converted to Pipedrive's
   * required HH:MM format internally.
   */
  async logActivity(
    personId: number,
    type: 'call' | 'sms',
    details: {
      subject: string;
      note?: string;
      /** Call duration in seconds (converted to HH:MM for Pipedrive) */
      duration?: number;
    }
  ): Promise<PipedriveActivity> {
    log.info('Logging activity', { personId, type, subject: details.subject });

    // Pipedrive only recognizes 'call' as a built-in type, not 'sms'
    const pdType = 'call';

    // Convert duration from seconds to Pipedrive's HH:MM format
    let pdDuration: string | undefined;
    if (details.duration && details.duration > 0) {
      const hours = Math.floor(details.duration / 3600);
      const minutes = Math.floor((details.duration % 3600) / 60);
      pdDuration = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    const activity = await this.request<PipedriveActivity>('/activities', {
      method: 'POST',
      body: JSON.stringify({
        type: pdType,
        subject: details.subject,
        person_id: personId,
        note: details.note,
        duration: pdDuration,
        done: true,
      }),
    });

    log.info('Logged activity', { activityId: activity.id, personId });
    return activity;
  }

  async createTask(
    personId: number,
    subject: string,
    note?: string
  ): Promise<PipedriveActivity> {
    log.info('Creating task', { personId, subject });

    const activity = await this.request<PipedriveActivity>('/activities', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task',
        subject,
        person_id: personId,
        note,
        done: false,
        due_date: new Date().toISOString().split('T')[0],
        due_time: new Date().toTimeString().slice(0, 5),
      }),
    });

    log.info('Created task', { activityId: activity.id, personId });
    return activity;
  }

  // ── Activity queries ─────────────────────────────────────────────

  /**
   * List activities with optional filters.
   *
   * Note: Pipedrive limits to 500 per page. Use `start` for pagination.
   * The caller is responsible for paginating if more results are needed.
   */
  async listActivities(filters?: {
    type?: string;          // 'call', 'sms', 'task'
    startDate?: string;     // YYYY-MM-DD
    endDate?: string;       // YYYY-MM-DD
    done?: boolean;
    limit?: number;         // max 500, default 100
    start?: number;         // pagination offset
  }): Promise<PipedriveActivity[]> {
    const params = new URLSearchParams();

    if (filters?.type) params.set('type', filters.type);
    if (filters?.startDate) params.set('start_date', filters.startDate);
    if (filters?.endDate) params.set('end_date', filters.endDate);
    if (filters?.done !== undefined) params.set('done', filters.done ? '1' : '0');
    if (filters?.limit) params.set('limit', String(filters.limit));
    if (filters?.start) params.set('start', String(filters.start));

    const query = params.toString();
    const endpoint = `/activities${query ? `?${query}` : ''}`;

    log.debug('Listing activities', { filters });

    const result = await this.request<PipedriveActivity[]>(endpoint);
    return result || [];
  }

  // ── Custom fields ───────────────────────────────────────────────

  async getPersonCustomField(personId: number, fieldKey: string): Promise<string | null> {
    const person = await this.getPerson(personId) as unknown as Record<string, unknown> | null;
    if (!person) return null;
    const value = person[fieldKey];
    return typeof value === 'string' && value ? value : null;
  }

  async setPersonCustomField(personId: number, fieldKey: string, value: string): Promise<void> {
    await this.request(`/persons/${personId}`, {
      method: 'PUT',
      body: JSON.stringify({ [fieldKey]: value }),
    });
  }

  // ── Static utilities ────────────────────────────────────────────

  static getPrimaryPhone(person: PipedrivePerson): string | null {
    const primary = person.phone?.find((p) => p.primary);
    return primary?.value || person.phone?.[0]?.value || null;
  }

  static getPrimaryEmail(person: PipedrivePerson): string | null {
    const primary = person.email?.find((e) => e.primary);
    return primary?.value || person.email?.[0]?.value || null;
  }

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
}
