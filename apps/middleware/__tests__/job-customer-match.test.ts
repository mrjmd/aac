import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  matchEventToDealAndPerson,
  expandNicknames,
  extractPhonesFromDescription,
} from '../lib/job-customer-match.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const mockGetDeal = vi.fn();
const mockGetPerson = vi.fn();
const mockSearchPersonByName = vi.fn();
const mockSearchPersonByPhone = vi.fn();

const pipedrive = {
  getDeal: mockGetDeal,
  getPerson: mockGetPerson,
  searchPersonByName: mockSearchPersonByName,
  searchPersonByPhone: mockSearchPersonByPhone,
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

    it('strips a trailing [cont] marker before name search (multi-day final day)', async () => {
      mockSearchPersonByName.mockResolvedValueOnce({ id: 77, name: 'Teddy Watler' });
      mockGetPerson.mockResolvedValueOnce({ id: 77, name: 'Teddy Watler' });

      const result = await matchEventToDealAndPerson(
        eventWith('Pool deck resurfacing', 'Teddy Watler [cont]'),
        pipedrive as any,
      );

      expect(mockSearchPersonByName).toHaveBeenCalledWith('Teddy Watler');
      expect(result.person?.id).toBe(77);
    });

    it('expands nicknames on the stripped name, not the raw [cont] title', async () => {
      mockSearchPersonByName.mockResolvedValueOnce(null); // "Bob Doherty" direct miss
      mockSearchPersonByName.mockImplementation(async (name: string) =>
        name === 'Robert Doherty' ? { id: 88, name: 'Robert Doherty' } : null,
      );
      mockGetPerson.mockResolvedValueOnce({ id: 88, name: 'Robert Doherty' });

      const result = await matchEventToDealAndPerson(
        eventWith('Day two of pad repairs', 'Bob Doherty [cont]'),
        pipedrive as any,
      );

      expect(result.person?.id).toBe(88);
      expect(mockSearchPersonByName).toHaveBeenCalledWith('Robert Doherty');
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

  describe('nickname fallback', () => {
    it('matches "Bob Doherty" when Pipedrive has "Robert Doherty"', async () => {
      mockSearchPersonByName.mockImplementation(async (name: string) =>
        name === 'Robert Doherty' ? { id: 6152, name: 'Robert Doherty' } : null,
      );
      mockGetPerson.mockResolvedValueOnce({ id: 6152, name: 'Robert Doherty' });

      const result = await matchEventToDealAndPerson(
        eventWith('Front step crack repairs', 'Bob Doherty'),
        pipedrive as any,
      );

      expect(result.person?.id).toBe(6152);
      expect(mockSearchPersonByName).toHaveBeenCalledWith('Bob Doherty');
      expect(mockSearchPersonByName).toHaveBeenCalledWith('Robert Doherty');
    });

    it('expands nicknames on compound-name candidates too', async () => {
      mockSearchPersonByName.mockImplementation(async (name: string) =>
        name === 'Susan Hendrickson' ? { id: 7, name: 'Susan Hendrickson' } : null,
      );
      mockGetPerson.mockResolvedValueOnce({ id: 7, name: 'Susan Hendrickson' });

      const result = await matchEventToDealAndPerson(
        eventWith('desc', 'Bob & Sue Hendrickson'),
        pipedrive as any,
      );

      expect(result.person?.id).toBe(7);
    });
  });

  describe('phone-in-description fallback', () => {
    it('matches via a phone in the description when the last name agrees', async () => {
      mockSearchPersonByName.mockResolvedValue(null);
      mockSearchPersonByPhone.mockImplementation(async (phone: string) =>
        phone === '+17817246317' ? { id: 6152, name: 'Robert Doherty' } : null,
      );
      mockGetPerson.mockResolvedValueOnce({ id: 6152, name: 'Robert Doherty' });

      const result = await matchEventToDealAndPerson(
        eventWith('Bobby Doherty (781) 724-6317 will meet you there.', 'Bobby Doherty'),
        pipedrive as any,
      );

      expect(result.person?.id).toBe(6152);
      expect(mockSearchPersonByPhone).toHaveBeenCalledWith('+17817246317');
    });

    it('rejects a phone match whose last name is not in the event title', async () => {
      mockSearchPersonByName.mockResolvedValue(null);
      mockSearchPersonByPhone.mockResolvedValue({ id: 99, name: 'Jill Property-Manager' });

      const result = await matchEventToDealAndPerson(
        eventWith('Call Jill (781) 291-9439 to be let in.', 'Bob Doherty'),
        pipedrive as any,
      );

      expect(result.person).toBeNull();
      expect(mockGetPerson).not.toHaveBeenCalled();
    });

    it('does not call phone search when the description has no phones', async () => {
      mockSearchPersonByName.mockResolvedValue(null);

      const result = await matchEventToDealAndPerson(
        eventWith('No numbers here', 'Nobody Match'),
        pipedrive as any,
      );

      expect(result.person).toBeNull();
      expect(mockSearchPersonByPhone).not.toHaveBeenCalled();
    });
  });
});

describe('expandNicknames', () => {
  it('expands a known nickname in both directions', () => {
    expect(expandNicknames('Bob Doherty')).toContain('Robert Doherty');
    expect(expandNicknames('Robert Doherty')).toContain('Bob Doherty');
  });

  it('returns [] for unknown first names and single words', () => {
    expect(expandNicknames('Zelda Doherty')).toEqual([]);
    expect(expandNicknames('Doherty')).toEqual([]);
  });

  it('preserves the rest of the name', () => {
    expect(expandNicknames('Jim St. Pierre')).toContain('James St. Pierre');
  });
});

describe('extractPhonesFromDescription', () => {
  it('extracts and normalizes phones in mixed formats, deduped', () => {
    expect(
      extractPhonesFromDescription(
        'Bob (781) 724-6317 will meet you. PM Jill 781.291.9439; again +1 781-724-6317.',
      ),
    ).toEqual(['+17817246317', '+17812919439']);
  });

  it('returns [] for empty or phone-free descriptions', () => {
    expect(extractPhonesFromDescription(undefined)).toEqual([]);
    expect(extractPhonesFromDescription('Quote #1492, unit #19')).toEqual([]);
  });
});
