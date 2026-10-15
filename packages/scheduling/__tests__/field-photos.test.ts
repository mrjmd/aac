import { describe, it, expect, vi } from 'vitest';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import {
  addressMatches,
  collectFieldPhotoAttachments,
  customerNameMatches,
  type CollectFieldPhotosDeps,
  type FieldCompletionRecord,
} from '../src/field-photos.js';
import { mergePhotoAttachments } from '../src/stub-photos.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

const BLOB_URL = (eventId: string, name: string) =>
  `https://abc123.public.blob.vercel-storage.com/field/${eventId}/${name}`;

function makeEvent(overrides: Record<string, unknown>) {
  return {
    id: 'ev1',
    summary: 'Rachel McCarthy',
    location: '122 Allen Avenue, Falmouth, Massachusetts, 02540',
    start: '2026-09-30T17:30:00.000Z',
    end: '2026-09-30T18:00:00.000Z',
    colorId: '3',
    attendees: ['mike@attackacrack.com'],
    htmlLink: '',
    attachments: [],
    ...overrides,
  };
}

function makeDeps(
  events: unknown[],
  completions: Record<string, FieldCompletionRecord | null>,
): { deps: CollectFieldPhotosDeps; mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const listEvents = vi.fn().mockResolvedValue(events);
  const fetchCompletion = vi.fn(
    (eventId: string) => Promise.resolve(completions[eventId] ?? null),
  );
  const download = vi.fn().mockResolvedValue({
    data: Buffer.from([1]),
    contentType: 'image/jpeg',
  });
  const ensureFolder = vi.fn().mockResolvedValue('FOLDER1');
  const uploadFile = vi.fn().mockImplementation(({ name }: { name: string }) =>
    Promise.resolve({ id: `id-${name}`, fileUrl: `https://drive.google.com/open?id=id-${name}` }),
  );
  const shareWithUsers = vi.fn().mockResolvedValue(undefined);

  return {
    deps: {
      cal: { listEvents } as unknown as GoogleCalendarClient,
      drive: { ensureFolder, uploadFile, shareWithUsers } as unknown as GoogleDriveClient,
      fetchCompletion,
      download,
      now: () => NOW,
    },
    mocks: { listEvents, fetchCompletion, download, ensureFolder, uploadFile, shareWithUsers },
  };
}

const INPUT = {
  customerName: 'Rachael McCarthy', // stub spelling, drifted from the visit's "Rachel"
  customerAddress: '122 Allen Ave, Falmouth, MA, USA',
  shareWithEmails: ['mike@attackacrack.com'],
};

describe('customerNameMatches', () => {
  it('tolerates given-name spelling drift with the same surname', () => {
    expect(customerNameMatches('Rachel McCarthy', 'Rachael McCarthy')).toBe(true);
  });

  it('strips STUB/HOLD prefixes before comparing', () => {
    expect(customerNameMatches('STUB — Rachel McCarthy', 'Rachael McCarthy')).toBe(true);
  });

  it('rejects different surnames and unrelated events', () => {
    expect(customerNameMatches('Rachel Smith', 'Rachael McCarthy')).toBe(false);
    expect(customerNameMatches('Mike OOO', 'Rachael McCarthy')).toBe(false);
    expect(customerNameMatches('BNI Meeting', 'Rachael McCarthy')).toBe(false);
  });

  it('requires exact match for single-token names', () => {
    expect(customerNameMatches('McCarthy', 'McCarthy')).toBe(true);
    expect(customerNameMatches('McCarthy', 'McCarthey')).toBe(false);
  });
});

describe('addressMatches', () => {
  it('matches on street number + first street word across formats', () => {
    expect(
      addressMatches('122 Allen Avenue, Falmouth, Massachusetts, 02540', '122 Allen Ave, Falmouth, MA, USA'),
    ).toBe(true);
  });

  it('rejects different numbers or streets, and missing values', () => {
    expect(addressMatches('124 Allen Ave', '122 Allen Ave')).toBe(false);
    expect(addressMatches('122 Birch St', '122 Allen Ave')).toBe(false);
    expect(addressMatches(null, '122 Allen Ave')).toBe(false);
  });
});

describe('collectFieldPhotoAttachments', () => {
  it('finds the prior visit by fuzzy name and attaches its photos', async () => {
    const { deps, mocks } = makeDeps([makeEvent({})], {
      ev1: {
        photos: [
          { url: BLOB_URL('ev1', 'photo-1.jpg'), label: 'photo', takenAt: '2026-10-01T10:35:00.000Z' },
          { url: BLOB_URL('ev1', 'extra-2.jpg'), label: 'extra', takenAt: '2026-10-01T10:36:00.000Z' },
        ],
      },
    });

    const result = await collectFieldPhotoAttachments(deps, INPUT);

    expect(result.map((a) => a.title)).toEqual(['photo-1.jpg', 'extra-2.jpg']);
    expect(mocks.fetchCompletion).toHaveBeenCalledWith('ev1');
    expect(mocks.shareWithUsers).toHaveBeenCalledWith('id-photo-1.jpg', ['mike@attackacrack.com']);
  });

  it('falls back to address match when the name is unrecognizable', async () => {
    const { deps } = makeDeps(
      [makeEvent({ summary: 'Assessment (realtor referral)' })],
      {
        ev1: {
          photos: [{ url: BLOB_URL('ev1', 'photo-1.jpg'), label: 'photo', takenAt: '2026-10-01T10:35:00.000Z' }],
        },
      },
    );

    const result = await collectFieldPhotoAttachments(deps, INPUT);
    expect(result).toHaveLength(1);
  });

  it('skips future events, videos, and visits without completion records', async () => {
    const { deps, mocks } = makeDeps(
      [
        makeEvent({}),
        makeEvent({ id: 'future', start: '2026-11-17T18:00:00.000Z', end: '2026-11-17T21:30:00.000Z' }),
      ],
      {
        ev1: {
          photos: [
            { url: BLOB_URL('ev1', 'clip.mp4'), label: 'extra', takenAt: '2026-10-01T10:35:00.000Z', kind: 'video' as const },
          ],
        },
      },
    );

    const result = await collectFieldPhotoAttachments(deps, INPUT);

    expect(result).toEqual([]);
    expect(mocks.fetchCompletion).not.toHaveBeenCalledWith('future');
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it('caps at maxPhotos keeping the most recent across visits', async () => {
    const { deps } = makeDeps(
      [makeEvent({}), makeEvent({ id: 'ev2', start: '2026-08-01T13:00:00.000Z', end: '2026-08-01T16:00:00.000Z' })],
      {
        ev1: {
          photos: [
            { url: BLOB_URL('ev1', 'new-1.jpg'), label: 'photo', takenAt: '2026-10-01T10:00:00.000Z' },
            { url: BLOB_URL('ev1', 'new-2.jpg'), label: 'extra', takenAt: '2026-10-01T11:00:00.000Z' },
          ],
        },
        ev2: {
          photos: [{ url: BLOB_URL('ev2', 'old.jpg'), label: 'photo', takenAt: '2026-08-01T15:00:00.000Z' }],
        },
      },
    );

    const result = await collectFieldPhotoAttachments(deps, { ...INPUT, maxPhotos: 2 });
    expect(result.map((a) => a.title)).toEqual(['new-1.jpg', 'new-2.jpg']);
  });

  it('returns [] when the calendar fetch throws (never blocks stub creation)', async () => {
    const { deps, mocks } = makeDeps([], {});
    mocks.listEvents.mockRejectedValueOnce(new Error('Calendar 500'));
    await expect(collectFieldPhotoAttachments(deps, INPUT)).resolves.toEqual([]);
  });
});

describe('mergePhotoAttachments', () => {
  const att = (title: string) => ({ fileUrl: `u-${title}`, title, mimeType: 'image/jpeg' });

  it('concatenates in priority order and drops duplicate titles', () => {
    const merged = mergePhotoAttachments([
      [att('a.jpg'), att('b.jpg')],
      [att('b.jpg'), att('c.jpg')],
    ]);
    expect(merged.map((a) => a.title)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('caps the total', () => {
    const merged = mergePhotoAttachments([[att('1'), att('2')], [att('3')]], 2);
    expect(merged.map((a) => a.title)).toEqual(['1', '2']);
  });
});
