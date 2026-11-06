/**
 * Unit tests for the per-concern modules behind api/webhooks/pipedrive.ts
 * (lib/pipedrive-webhook/*). The end-to-end handler behavior lives in
 * webhooks-pipedrive.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logHealthErrorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/redis.js', () => ({ logHealthError: logHealthErrorMock }));

import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuoClient } from '@aac/api-clients/quo';
import type { PipedrivePersonPayload } from '../lib/pipedrive-webhook/types.js';
import { verifyPdWebhookAuth } from '../lib/pipedrive-webhook/auth.js';
import { extractPrimaryPhone, loadPersonSyncData } from '../lib/pipedrive-webhook/person-data.js';
import { enrichQuoContact } from '../lib/pipedrive-webhook/quo-enrich.js';

const JOB_TITLE = '6483bb4aaf895975a61ec08210d17978769a8e85';
const ADDR = '5fc7cf5d8c890fe2f7062aaabe1e9b416c851511';

function person(overrides: Partial<PipedrivePersonPayload> = {}): PipedrivePersonPayload {
  return {
    id: 101,
    name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    phones: [{ value: '+16175550123', primary: true, label: 'mobile' }],
    emails: [],
    org_id: null,
    org_name: null,
    owner_id: 1,
    ...overrides,
  };
}

function pdMock(fullPerson: Record<string, unknown> | null = null) {
  return {
    getOrganization: vi.fn().mockResolvedValue({ name: 'Acme Realty' }),
    getPerson: vi.fn().mockResolvedValue(fullPerson),
  };
}
const asPd = (m: ReturnType<typeof pdMock>) => m as unknown as PipedriveClient;

beforeEach(() => vi.clearAllMocks());

describe('verifyPdWebhookAuth', () => {
  const good = `Basic ${Buffer.from('u:p').toString('base64')}`;
  it('accepts matching Basic credentials', () => {
    expect(verifyPdWebhookAuth(good, 'u', 'p')).toBe(true);
  });
  it('rejects missing, non-Basic, wrong-length and wrong credentials', () => {
    expect(verifyPdWebhookAuth(undefined, 'u', 'p')).toBe(false);
    expect(verifyPdWebhookAuth('Bearer abc', 'u', 'p')).toBe(false);
    expect(verifyPdWebhookAuth('Basic abc', 'u', 'p')).toBe(false);
    expect(verifyPdWebhookAuth(`Basic ${Buffer.from('u:q').toString('base64')}`, 'u', 'p')).toBe(false);
  });
});

describe('extractPrimaryPhone', () => {
  it('prefers the primary phone, else the first, else null', () => {
    expect(
      extractPrimaryPhone([
        { value: '1', primary: false, label: '' },
        { value: '2', primary: true, label: '' },
      ]),
    ).toBe('2');
    expect(extractPrimaryPhone([{ value: '1', primary: false, label: '' }])).toBe('1');
    expect(extractPrimaryPhone([])).toBeNull();
    expect(extractPrimaryPhone(undefined)).toBeNull();
  });
});

describe('loadPersonSyncData', () => {
  it('reads name, email, job title and the structured address from the full person', async () => {
    const pd = pdMock({
      [JOB_TITLE]: 'Broker',
      [`${ADDR}_street_number`]: '12',
      [`${ADDR}_route`]: 'Elm St',
      [`${ADDR}_locality`]: 'Quincy',
      [`${ADDR}_admin_area_level_1`]: 'MA',
      [`${ADDR}_postal_code`]: '02169',
    });
    const out = await loadPersonSyncData(
      asPd(pd),
      person({
        emails: [
          { value: 'other@example.com', primary: false, label: '' },
          { value: 'jane@example.com', primary: true, label: '' },
        ],
      }),
    );
    expect(out).toEqual({
      personName: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
      company: undefined,
      jobTitle: 'Broker',
      primaryEmail: 'jane@example.com',
      addressLine1: '12 Elm St',
      locality: 'Quincy',
      state: 'MA',
      postalCode: '02169',
      formattedAddress: '12 Elm St, Quincy, MA, 02169',
    });
    expect(pd.getOrganization).not.toHaveBeenCalled();
  });

  it('fetches the org name when only org_id is present; falls back to the raw address field', async () => {
    const pd = pdMock({ [ADDR]: '1 Main St, Boston' });
    const out = await loadPersonSyncData(asPd(pd), person({ org_id: 9, name: '' }));
    expect(pd.getOrganization).toHaveBeenCalledWith(9);
    expect(out.company).toBe('Acme Realty');
    expect(out.personName).toBe('Unknown');
    expect(out.addressLine1).toBe('1 Main St, Boston');
    expect(out.formattedAddress).toBe('1 Main St, Boston');
  });

  it('skips getPerson when the payload already carries a job title and no org', async () => {
    const pd = pdMock();
    const out = await loadPersonSyncData(asPd(pd), person({ [JOB_TITLE]: 'Owner' }));
    expect(pd.getPerson).not.toHaveBeenCalled();
    expect(out.jobTitle).toBe('Owner');
    expect(out.formattedAddress).toBeUndefined();
  });
});

describe('enrichQuoContact', () => {
  it('writes the QB link and address custom fields', async () => {
    const quo = { updateContact: vi.fn().mockResolvedValue(undefined) };
    await enrichQuoContact(quo as unknown as QuoClient, person(), 'q-1', '77', '1 Main St');
    expect(quo.updateContact).toHaveBeenCalledWith('q-1', {
      customFields: [
        { key: '69c6ac9e7d6fcf298f2a1cbc', value: 'https://app.qbo.intuit.com/app/customerdetail?nameId=77' },
        { key: '1725478449101', value: '1 Main St' },
      ],
    });
  });

  it('writes only the address when there is no QB customer', async () => {
    const quo = { updateContact: vi.fn().mockResolvedValue(undefined) };
    await enrichQuoContact(quo as unknown as QuoClient, person(), 'q-1', null, '1 Main St');
    expect(quo.updateContact).toHaveBeenCalledWith('q-1', {
      customFields: [{ key: '1725478449101', value: '1 Main St' }],
    });
  });

  it('surfaces a failure to health without throwing', async () => {
    const quo = { updateContact: vi.fn().mockRejectedValue(new Error('quo 500')) };
    await expect(
      enrichQuoContact(quo as unknown as QuoClient, person(), 'q-1', '77', undefined),
    ).resolves.toBeUndefined();
    expect(logHealthErrorMock).toHaveBeenCalledWith('pipedrive', 'Quo enrichment failed: quo 500', {
      quoId: 'q-1',
      pipedriveId: '101',
    });
  });
});
