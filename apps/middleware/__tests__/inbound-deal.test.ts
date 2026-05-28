import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureInboundLeadDeal } from '../lib/inbound-deal.js';
import type { PipedriveDeal } from '@aac/api-clients/pipedrive';

const mockFindDealByExternalId = vi.fn();
const mockCreateDeal = vi.fn();

const pipedrive = {
  findDealByExternalId: mockFindDealByExternalId,
  createDeal: mockCreateDeal,
};

const existingDeal: PipedriveDeal = {
  id: 7,
  title: 'Inbound lead +15551234567',
  personId: 100,
  organizationId: null,
  stageId: 1,
  stage: 'lead',
  pipelineId: 1,
  value: null,
  currency: null,
  status: 'open',
  qbEstimateId: null,
  qbInvoiceId: null,
  externalId: 'pd-person-100',
  lostReason: null,
  addTime: '2026-05-28 12:00:00',
  updateTime: '2026-05-28 12:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureInboundLeadDeal', () => {
  it('returns the existing deal when one matches the external_id', async () => {
    mockFindDealByExternalId.mockResolvedValueOnce(existingDeal);

    const result = await ensureInboundLeadDeal(pipedrive as any, 100, '+15551234567');

    expect(result).toBe(existingDeal);
    expect(mockFindDealByExternalId).toHaveBeenCalledWith('pd-person-100');
    expect(mockCreateDeal).not.toHaveBeenCalled();
  });

  it('creates a Lead-stage deal when none exists', async () => {
    mockFindDealByExternalId.mockResolvedValueOnce(null);
    mockCreateDeal.mockResolvedValueOnce({ ...existingDeal, id: 42 });

    const result = await ensureInboundLeadDeal(pipedrive as any, 200, '+15555550100');

    expect(result.id).toBe(42);
    expect(mockCreateDeal).toHaveBeenCalledWith({
      title: 'Inbound lead +15555550100',
      personId: 200,
      stage: 'lead',
      externalId: 'pd-person-200',
    });
  });

  it('propagates errors from findDealByExternalId', async () => {
    mockFindDealByExternalId.mockRejectedValueOnce(new Error('dealSpine not configured'));

    await expect(ensureInboundLeadDeal(pipedrive as any, 1, '+15551234567')).rejects.toThrow(
      'dealSpine not configured',
    );
    expect(mockCreateDeal).not.toHaveBeenCalled();
  });

  it('propagates errors from createDeal', async () => {
    mockFindDealByExternalId.mockResolvedValueOnce(null);
    mockCreateDeal.mockRejectedValueOnce(new Error('PD 500'));

    await expect(ensureInboundLeadDeal(pipedrive as any, 1, '+15551234567')).rejects.toThrow(
      'PD 500',
    );
  });
});
