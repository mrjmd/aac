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

/**
 * Minimum gap between outbound requests. Pipedrive's API-token budget is
 * burst-sensitive; spacing calls keeps batch jobs (e.g. the deal-reconcile
 * cron, which loops one search/update per QB record) under the limit.
 */
const REQUEST_DELAY_MS = 200;
/** Max 429 retries before giving up and surfacing the error to the caller. */
const MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Interfaces ───────────────────────────────────────────────────────

export interface PipedriveConfig {
  apiKey: string;
  companyDomain: string;
  systemUserId?: string;
  /**
   * Required to call any of the deal-spine methods (createDeal, getDeal,
   * updateDeal, etc.). Holds the pipeline + stage IDs and custom-field
   * hashes from the PD account. Production callers typically pass the
   * module-level constants ({@link DEAL_PIPELINE_ID}, {@link DEAL_STAGE_IDS},
   * {@link DEAL_FIELD_HASHES}); tests pass fake values.
   */
  dealSpine?: PipedriveDealSpineConfig;
}

export interface PipedriveDealSpineConfig {
  pipelineId: number;
  stageIds: Record<DealStage, number>;
  fieldHashes: {
    qbEstimateId: string;
    qbInvoiceId: string;
    externalId: string;
    lostReason: string;
  };
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

// ── Deal-spine types and constants ───────────────────────────────────
//
// The "Deal Spine" pipeline holds one PD deal per opportunity, with
// foreign keys to the QB estimate + QB invoice for that specific deal.
// Calendar events link to deals via the [deal:N] marker in event
// descriptions (not via a deal-side foreign key) — a deal can have many
// events (assessment + multi-day repair + callbacks).
// See docs/projects/apps-agent.md → "Deal model".

export type DealStage =
  | 'lead'
  | 'qualified_lead'
  | 'assessment_scheduled'
  | 'assessment_done'
  | 'quote_sent'
  | 'quote_accepted'
  | 'job_scheduled'
  | 'job_done'
  | 'paid'
  | 'lost';

export const DEAL_STAGES: readonly DealStage[] = [
  'lead',
  'qualified_lead',
  'assessment_scheduled',
  'assessment_done',
  'quote_sent',
  'quote_accepted',
  'job_scheduled',
  'job_done',
  'paid',
  'lost',
] as const;

export type LostReason =
  | 'out_of_scope'
  | 'competitor'
  | 'price'
  | 'no_response'
  | 'cancelled'
  | 'passed_after_assessment'
  | 'other';

export const LOST_REASONS: readonly LostReason[] = [
  'out_of_scope',
  'competitor',
  'price',
  'no_response',
  'cancelled',
  'passed_after_assessment',
  'other',
] as const;

/**
 * Pipeline + stage numeric IDs from the Pipedrive "Deal Spine" pipeline.
 * Captured 2026-05-28 via the PD API. The setup is done once per PD
 * account; rebuilding requires re-querying.
 */
export const DEAL_PIPELINE_ID = 1;
export const DEAL_STAGE_IDS: Record<DealStage, number> = {
  lead: 1,
  qualified_lead: 2,
  assessment_scheduled: 3,
  assessment_done: 4,
  quote_sent: 5,
  quote_accepted: 6,
  job_scheduled: 7,
  job_done: 8,
  paid: 9,
  lost: 10,
};

/**
 * Custom field hashes on the PD Deal entity, captured 2026-05-28 by
 * running `tools/src/setup/pd-deal-fields.ts`. The script is idempotent
 * and prints these in pastable form on completion.
 */
export const DEAL_FIELD_HASHES = {
  qbEstimateId: '76504be3459616278c74b37382d8d5f7b9494ce6',
  qbInvoiceId: '46da1cadafb407788134455e0e5ab7185cc89f39',
  externalId: '1bbb93176685d776de300e11bf7c78214551f9b7',
  lostReason: '0bc3744e0a783ee5e4460b9be35c2b6325f5e598',
} as const;

/**
 * Parse the `[deal:N]` marker from a calendar event description. Returns
 * the deal ID if present, or null. The marker is the canonical deal↔event
 * link: see docs/projects/apps-agent.md → "Deal model". A single deal can
 * carry many events (assessment + multi-day repair + callbacks) so the
 * marker lives on the event side, not as a deal-side foreign key.
 */
export function parseDealMarker(description: string | null | undefined): number | null {
  if (!description) return null;
  const match = description.match(/\[deal:(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}

export interface PipedriveDeal {
  id: number;
  title: string;
  personId: number | null;
  organizationId: number | null;
  stageId: number;
  stage: DealStage | null; // derived from stageId via DEAL_STAGE_IDS reverse lookup
  pipelineId: number;
  value: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | 'deleted';
  qbEstimateId: string | null;
  qbInvoiceId: string | null;
  externalId: string | null;
  lostReason: LostReason | null;
  addTime: string;
  updateTime: string;
}

export interface CreateDealInput {
  title: string;
  personId: number;
  stage?: DealStage; // defaults to 'lead' if omitted
  value?: number;
  qbEstimateId?: string;
  qbInvoiceId?: string;
  externalId?: string;
}

export interface UpdateDealInput {
  title?: string;
  value?: number;
  qbEstimateId?: string;
  qbInvoiceId?: string;
  externalId?: string;
}

// ── Name refinement logic ────────────────────────────────────────────

/**
 * Common English first-name nickname groups. Names within a group are
 * considered equivalent for refinement purposes (e.g. "Tom" → "Thomas Smith"
 * is allowed, since Tom and Thomas are in the same group).
 *
 * Conservative by design — only well-established pairs. Edge cases (cultural
 * variants, gender-shared roots) are intentionally limited.
 */
const NICKNAME_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['tom', 'thomas', 'tommy'],
  ['mike', 'michael', 'mikey'],
  ['bob', 'rob', 'robert', 'bobby', 'robbie'],
  ['bill', 'will', 'william', 'billy', 'willy'],
  ['jim', 'james', 'jimmy', 'jamie'],
  ['liz', 'beth', 'elizabeth', 'eliza', 'lizzy', 'betty'],
  ['kate', 'katie', 'kathy', 'katherine', 'kathryn', 'cathy', 'catherine'],
  ['joe', 'joey', 'joseph'],
  ['steve', 'stephen', 'steven'],
  ['chris', 'christopher', 'christina', 'christine', 'christine'],
  ['jen', 'jenny', 'jennifer'],
  ['sue', 'suzy', 'susan', 'susanna', 'suzanne'],
  ['sam', 'sammy', 'samuel', 'samantha'],
  ['rick', 'ricky', 'rich', 'richard', 'dick'],
  ['nick', 'nicky', 'nicholas'],
  ['dan', 'danny', 'daniel'],
  ['matt', 'matty', 'matthew'],
  ['dave', 'davey', 'david'],
  ['ed', 'eddie', 'eddy', 'edward'],
  ['fred', 'freddy', 'frederick'],
  ['greg', 'gregory'],
  ['hank', 'henry'],
  ['jack', 'johnny', 'john', 'jonathan'],
  ['tony', 'anthony'],
  ['pete', 'peter'],
  ['phil', 'philip', 'phillip'],
  ['ron', 'ronnie', 'ronald'],
  ['vinny', 'vince', 'vincent'],
  ['ben', 'benny', 'benjamin'],
  ['pat', 'patty', 'patrick', 'patricia'],
  ['gabe', 'gabriel'],
  ['nate', 'nathan', 'nathaniel'],
  ['alex', 'alexander', 'alexandra'],
  ['andy', 'andrew', 'andrea'],
  ['cindy', 'cynthia'],
  ['debbie', 'deborah', 'debra'],
  ['frank', 'francis', 'francisco'],
  ['gerry', 'jerry', 'gerald'],
  ['kim', 'kimberly'],
  ['marg', 'maggie', 'meg', 'peggy', 'margaret'],
  ['vicky', 'victoria'],
  ['les', 'leslie', 'lester'],
  ['charlie', 'chuck', 'charles'],
  ['don', 'donny', 'donald'],
  ['stan', 'stanley'],
  ['walt', 'walter'],
  ['abby', 'abigail'],
  ['becky', 'rebecca'],
  ['mel', 'melanie', 'melissa'],
  ['mol', 'molly', 'mary'],
];

/** Flattened lookup: lowercased name → set of equivalent names. */
const NICKNAME_LOOKUP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of NICKNAME_GROUPS) {
    const set = new Set(group);
    for (const name of group) {
      // Last group wins on conflict — kept simple, groups are curated to not overlap badly.
      map.set(name, set);
    }
  }
  return map;
})();

/** Two first names are equivalent if they're identical or in the same nickname group. */
function areEquivalentFirstNames(a: string, b: string): boolean {
  if (a === b) return true;
  const group = NICKNAME_LOOKUP.get(a);
  return group ? group.has(b) : false;
}

/**
 * A "placeholder" name is one we should freely overwrite with any extracted name.
 * Includes our own disambiguator suffixes ("Sam (·9554)") and the "Unknown Lead..."
 * pattern from initial contact creation.
 */
function isPlaceholderName(name: string): boolean {
  if (!name || !name.trim()) return true;
  const trimmed = name.trim();
  if (trimmed.startsWith('Unknown Lead')) return true;
  if (/^Lead\s*\(·\d{4}\)$/.test(trimmed)) return true;
  // Our own single-token + phone-suffix disambiguator
  if (/^\S+\s*\(·\d{4}\)$/.test(trimmed)) return true;
  // Bare phone number used as a name
  const stripped = trimmed.replace(/[\s()+\-.]/g, '');
  if (/^\d{7,}$/.test(stripped)) return true;
  return false;
}

/**
 * A new name "refines" the current name if it adds tokens without contradicting
 * any existing token. Specifically:
 *   - new has strictly more tokens than current
 *   - first tokens are equivalent (identical or known nicknames)
 *   - every non-first token in current appears in new (in any position)
 *
 * Examples:
 *   "Sam" → "Sam Sabky"           ✓ (same first, more tokens)
 *   "Tom" → "Thomas Pfalzer"      ✓ (nickname pair)
 *   "Sam Sabky" → "Sam J. Sabky"  ✓ (last-name preserved, middle initial added)
 *   "Sam Sabky" → "Lisa Hartley"  ✗ (different first)
 *   "Sam Sabky" → "Sam Saby"      ✗ (no extra tokens; degradation)
 *   "Sam" → "Tom Sabky"           ✗ (different first, not nicknames)
 */
export function isNameRefinement(currentName: string, newName: string): boolean {
  const cur = currentName.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const nu = newName.toLowerCase().trim().split(/\s+/).filter(Boolean);

  if (cur.length === 0 || nu.length === 0) return false;
  if (nu.length <= cur.length) return false;
  if (!areEquivalentFirstNames(cur[0], nu[0])) return false;

  for (let i = 1; i < cur.length; i++) {
    if (!nu.includes(cur[i])) return false;
  }
  return true;
}

/**
 * Decide whether to overwrite a Pipedrive person's name with a newly-extracted one.
 *
 * Allows updates when the existing name is a placeholder, OR when the new name
 * is a strict refinement (extends without contradicting). Blocks third-party
 * names mentioned in conversation (different first name) and degradations
 * (same/fewer tokens).
 */
export function shouldUpdateName(currentName: string | undefined, newName: string | undefined): boolean {
  if (!newName || !newName.trim()) return false;
  if (!currentName || isPlaceholderName(currentName)) return true;
  return isNameRefinement(currentName, newName);
}

// ── Client ───────────────────────────────────────────────────────────

export class PipedriveClient {
  private lastRequestTime = 0;

  constructor(private config: PipedriveConfig) {}

  // ── Private request helper ──────────────────────────────────────

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const baseUrl = 'https://api.pipedrive.com/v1';
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set('api_token', this.config.apiKey);

    for (let attempt = 0; ; attempt++) {
      // Throttle: keep a minimum gap since the last request so batch jobs
      // don't trip Pipedrive's burst limit in the first place.
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < REQUEST_DELAY_MS) {
        await sleep(REQUEST_DELAY_MS - elapsed);
      }
      this.lastRequestTime = Date.now();

      const response = await fetch(url.toString(), {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      // 429 = rate limited. Back off and retry; honor Retry-After when
      // Pipedrive sends it, otherwise exponential (2s, 4s, 8s).
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const backoffMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** (attempt + 1) * 1000;
        log.warn('Pipedrive rate limited; backing off', {
          endpoint,
          attempt: attempt + 1,
          backoffMs,
        });
        await sleep(backoffMs);
        continue;
      }

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

    // Update name if the existing name is a placeholder OR the new name strictly
    // refines the existing one (same first name / known nickname + adds tokens).
    // See shouldUpdateName / isNameRefinement above for the full rule set.
    if (updates.name && shouldUpdateName(person.name, updates.name)) {
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

  /**
   * List activities for a specific person.
   */
  async getPersonActivities(personId: number, options?: {
    limit?: number;
    start?: number;
  }): Promise<PipedriveActivity[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.start) params.set('start', String(options.start));

    const query = params.toString();
    const endpoint = `/persons/${personId}/activities${query ? `?${query}` : ''}`;

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

  // ── General read access ──────────────────────────────────────────
  // Escape hatches so callers can pull arbitrary entities + custom
  // fields without us having to wrap every Pipedrive resource.

  async rawGet<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {}
  ): Promise<{
    success: boolean;
    data: T;
    additional_data?: {
      pagination?: {
        start: number;
        limit: number;
        more_items_in_collection: boolean;
        next_start?: number;
      };
    };
  }> {
    const baseUrl = 'https://api.pipedrive.com/v1';
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set('api_token', this.config.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      log.error('Pipedrive raw GET failed', new Error(error), { endpoint, status: response.status });
      throw new Error(`Pipedrive API error: ${response.status} - ${error}`);
    }
    return response.json();
  }

  // ── Deal CRUD ────────────────────────────────────────────────────
  //
  // All deal methods operate on the "Deal Spine" pipeline (see
  // docs/projects/apps-agent.md → "Deal model"). The pipeline + stage IDs
  // and custom-field hashes come from `config.dealSpine` passed to the
  // constructor; deal methods throw a clear error if the caller didn't
  // configure it.

  private requireDealSpine(): PipedriveDealSpineConfig {
    if (!this.config.dealSpine) {
      throw new Error(
        'PipedriveClient.config.dealSpine is required for deal-CRUD methods. ' +
          'Pass { pipelineId, stageIds, fieldHashes } from DEAL_* constants in pipedrive.ts.',
      );
    }
    return this.config.dealSpine;
  }

  private stageNameToId(stage: DealStage): number {
    const spine = this.requireDealSpine();
    const id = spine.stageIds[stage];
    if (!id) {
      throw new Error(`Stage ID for "${stage}" is not configured in dealSpine.stageIds`);
    }
    return id;
  }

  private stageIdToName(stageId: number): DealStage | null {
    const spine = this.config.dealSpine;
    if (!spine) return null;
    for (const stage of DEAL_STAGES) {
      if (spine.stageIds[stage] === stageId) return stage;
    }
    return null;
  }

  private readStringField(raw: Record<string, unknown>, hash: string): string | null {
    if (!hash) return null;
    const v = raw[hash];
    return typeof v === 'string' && v ? v : null;
  }

  /** PD returns person_id / org_id as either a number or an object with .value. Normalize. */
  private extractPdRelationId(value: unknown): number | null {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object' && 'value' in value) {
      const v = (value as { value: unknown }).value;
      return typeof v === 'number' ? v : null;
    }
    return null;
  }

  private parseDeal(raw: Record<string, unknown>): PipedriveDeal {
    const stageId = Number(raw.stage_id);
    const fieldHashes = this.config.dealSpine?.fieldHashes;
    const lostReasonRaw = fieldHashes
      ? this.readStringField(raw, fieldHashes.lostReason)
      : null;
    const lostReason =
      lostReasonRaw && (LOST_REASONS as readonly string[]).includes(lostReasonRaw)
        ? (lostReasonRaw as LostReason)
        : null;

    return {
      id: Number(raw.id),
      title: String(raw.title ?? ''),
      personId: this.extractPdRelationId(raw.person_id),
      organizationId: this.extractPdRelationId(raw.org_id),
      stageId,
      stage: this.stageIdToName(stageId),
      pipelineId: Number(raw.pipeline_id ?? 0),
      value: raw.value == null ? null : Number(raw.value),
      currency: raw.currency == null ? null : String(raw.currency),
      status: (raw.status as PipedriveDeal['status']) ?? 'open',
      qbEstimateId: fieldHashes ? this.readStringField(raw, fieldHashes.qbEstimateId) : null,
      qbInvoiceId: fieldHashes ? this.readStringField(raw, fieldHashes.qbInvoiceId) : null,
      externalId: fieldHashes ? this.readStringField(raw, fieldHashes.externalId) : null,
      lostReason,
      addTime: String(raw.add_time ?? ''),
      updateTime: String(raw.update_time ?? ''),
    };
  }

  async createDeal(input: CreateDealInput): Promise<PipedriveDeal> {
    const spine = this.requireDealSpine();
    const stage = input.stage ?? 'lead';
    const body: Record<string, unknown> = {
      title: input.title,
      person_id: input.personId,
      pipeline_id: spine.pipelineId,
      stage_id: this.stageNameToId(stage),
    };
    if (input.value !== undefined) body.value = input.value;
    if (input.qbEstimateId !== undefined) {
      body[spine.fieldHashes.qbEstimateId] = input.qbEstimateId;
    }
    if (input.qbInvoiceId !== undefined) {
      body[spine.fieldHashes.qbInvoiceId] = input.qbInvoiceId;
    }
    if (input.externalId !== undefined) {
      body[spine.fieldHashes.externalId] = input.externalId;
    }

    log.info('Creating deal', { title: input.title, personId: input.personId, stage });
    const raw = await this.request<Record<string, unknown>>('/deals', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.parseDeal(raw);
  }

  async getDeal(id: number): Promise<PipedriveDeal | null> {
    try {
      const raw = await this.request<Record<string, unknown>>(`/deals/${id}`);
      return this.parseDeal(raw);
    } catch (error) {
      log.error('Get deal failed', error as Error, { dealId: id });
      return null;
    }
  }

  async updateDeal(id: number, updates: UpdateDealInput): Promise<PipedriveDeal> {
    const spine = this.requireDealSpine();
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.value !== undefined) body.value = updates.value;
    if (updates.qbEstimateId !== undefined) {
      body[spine.fieldHashes.qbEstimateId] = updates.qbEstimateId;
    }
    if (updates.qbInvoiceId !== undefined) {
      body[spine.fieldHashes.qbInvoiceId] = updates.qbInvoiceId;
    }
    if (updates.externalId !== undefined) {
      body[spine.fieldHashes.externalId] = updates.externalId;
    }

    const raw = await this.request<Record<string, unknown>>(`/deals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return this.parseDeal(raw);
  }

  async getDealsByPerson(personId: number): Promise<PipedriveDeal[]> {
    const res = await this.rawGet<Record<string, unknown>[] | null>(
      `/persons/${personId}/deals`,
    );
    if (!res.data) return [];
    return res.data.map((raw) => this.parseDeal(raw));
  }

  /**
   * List deals across the configured pipeline, optionally filtered by stage
   * and status. Used by apps/agent's listDeals read-tool — keeps the tool
   * layer free of raw `/deals` query params. Single page (PD default 500).
   */
  async listDeals(
    opts: {
      stage?: DealStage;
      status?: 'open' | 'won' | 'lost' | 'deleted' | 'all_not_deleted';
      limit?: number;
    } = {},
  ): Promise<PipedriveDeal[]> {
    this.requireDealSpine();
    const params: Record<string, string | number> = {
      limit: opts.limit ?? 500,
      sort: 'add_time DESC',
      status: opts.status ?? 'all_not_deleted',
    };
    if (opts.stage) {
      params.stage_id = this.stageNameToId(opts.stage);
    }
    const res = await this.rawGet<Record<string, unknown>[] | null>('/deals', params);
    if (!res.data) return [];
    return res.data.map((raw) => this.parseDeal(raw));
  }

  async setDealStage(id: number, stage: DealStage): Promise<PipedriveDeal> {
    this.requireDealSpine();
    const raw = await this.request<Record<string, unknown>>(`/deals/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ stage_id: this.stageNameToId(stage) }),
    });
    return this.parseDeal(raw);
  }

  /**
   * Move a deal to the Lost stage with status=lost and a stored reason.
   * PD's data model has both stage and status; we keep them aligned for
   * Lost deals so PD's analytics + UI lossifies them consistently.
   */
  async markDealLost(id: number, reason: LostReason): Promise<PipedriveDeal> {
    const spine = this.requireDealSpine();
    const body: Record<string, unknown> = {
      status: 'lost',
      stage_id: this.stageNameToId('lost'),
      [spine.fieldHashes.lostReason]: reason,
    };
    const raw = await this.request<Record<string, unknown>>(`/deals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return this.parseDeal(raw);
  }

  /**
   * Look up a deal by its `external_id` custom field. Used during backfill
   * + by deterministic webhook handlers to find "does a deal already exist
   * for QB estimate 1234?" without name-matching.
   *
   * Two-step lookup because PD's search returns a minimal item shape:
   * search for the deal, then fetch the full record.
   */
  async findDealByExternalId(externalId: string): Promise<PipedriveDeal | null> {
    this.requireDealSpine();
    const res = await this.rawGet<{ items?: Array<{ item: { id: number } }> } | null>(
      '/deals/search',
      {
        term: externalId,
        exact_match: 'true',
        fields: 'custom_fields',
      },
    );
    const items = res.data?.items;
    if (!items?.length) return null;
    return this.getDeal(items[0].item.id);
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
