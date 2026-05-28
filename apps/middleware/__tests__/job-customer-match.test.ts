import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchEventToDealAndPerson } from '../lib/job-customer-match.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const mockGetDeal = vi.fn();
const mockGetPerson = vi.fn();
const mockSearchPersonByName = vi.fn();

const pipedrive = {
  getDeal: mockGetDeal,
  getPerson: mockGetPerson,
  searchPersonByName: mockSearchPersonByName,
};

function eventWith(description: string, summary = 'Some Customer'): CalendarEvent {
  return {
    id: 'evt-1',
    summary,
    description,
    location: '1 Main St',
    start: '2026-05-28T08:00:00-04:00',
    end: '2026-05-28T12:00:00-04:00',
    colorId: '10',
    attendees: ['mike@attackacrack.com'],
    htmlLink: '',
    attachments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matchEventToDealAndPerson', () => {
  describe('deal marker fast path', () => {
    it('returns deal + person when the marker resolves', async () => {
      mockGetDeal.mockResolvedValueOnce({
        id: 42,
        personId: 100,
        qbEstimateId: 'qb-est-7',
        stage: 'job_scheduled',
      });
      mockGetPerson.mockResolvedValueOnce({ id: 100, name: 'Marker Customer' });

      const result = await matchEventToDealAndPerson(
        eventWith('Repair details [deal:42]'),
        pipedrive as any,
      );

      expect(result.deal?.id).toBe(42);
      expect(result.person?.id).toBe(100);
      expect(mockGetDeal).toHaveBeenCalledWith(42);
      expect(mockGetPerson).toHaveBeenCalledWith(100);
      // Falls through to name-match should NOT have been reached
      expect(mockSearchPersonByName).not.toHaveBeenCalled();
    });

    it('falls back to name-match when getDeal returns null', async () => {
      mockGetDeal.mockResolvedValueOnce(null);
      mockSearchPersonByName.mockResolvedValueOnce({ id: 5, name: 'Fallback' });
      mockGetPerson.mockResolvedValueOnce({ id: 5, name: 'Fallback' });

      const result = await matchEventToDealAndPerson(
        eventWith('[deal:999]', 'Fallback'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person?.id).toBe(5);
      expect(mockSearchPersonByName).toHaveBeenCalledWith('Fallback');
    });

    it('falls back when deal exists but personId is null', async () => {
      mockGetDeal.mockResolvedValueOnce({ id: 7, personId: null, stage: 'lead' });
      mockSearchPersonByName.mockResolvedValueOnce({ id: 1, name: 'Orphan Deal' });
      mockGetPerson.mockResolvedValueOnce({ id: 1, name: 'Orphan Deal' });

      const result = await matchEventToDealAndPerson(
        eventWith('[deal:7]', 'Orphan Deal'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person?.id).toBe(1);
    });

    it('falls back when getDeal throws (e.g. missing dealSpine config)', async () => {
      mockGetDeal.mockRejectedValueOnce(new Error('dealSpine not configured'));
      mockSearchPersonByName.mockResolvedValueOnce({ id: 2, name: 'Throw Fallback' });
      mockGetPerson.mockResolvedValueOnce({ id: 2, name: 'Throw Fallback' });

      const result = await matchEventToDealAndPerson(
        eventWith('[deal:1]', 'Throw Fallback'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person?.id).toBe(2);
    });
  });

  describe('without marker', () => {
    it('skips deal lookup entirely and uses name-match', async () => {
      mockSearchPersonByName.mockResolvedValueOnce({ id: 9, name: 'Plain Customer' });
      mockGetPerson.mockResolvedValueOnce({ id: 9, name: 'Plain Customer' });

      const result = await matchEventToDealAndPerson(
        eventWith('Foundation crack repair', 'Plain Customer'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person?.id).toBe(9);
      expect(mockGetDeal).not.toHaveBeenCalled();
    });

    it('honors the legacy PipedriveID: marker', async () => {
      mockGetPerson.mockResolvedValueOnce({ id: 1337, name: 'Legacy Marker' });

      const result = await matchEventToDealAndPerson(
        eventWith('PipedriveID: 1337', 'Legacy Marker'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person?.id).toBe(1337);
      expect(mockGetDeal).not.toHaveBeenCalled();
      expect(mockGetPerson).toHaveBeenCalledWith(1337);
    });

    it('returns {deal: null, person: null} when no match anywhere', async () => {
      mockSearchPersonByName.mockResolvedValue(null);

      const result = await matchEventToDealAndPerson(
        eventWith('No deal marker', 'Nobody Match'),
        pipedrive as any,
      );

      expect(result.deal).toBeNull();
      expect(result.person).toBeNull();
    });
  });
});
