/**
 * collectFieldPhotoAttachments — pull the photos Mike took in the field
 * app during the customer's previous visits (assessments, earlier jobs)
 * and turn them into stub-event attachments.
 *
 * Field-app photos are keyed ONLY by the calendar event ID of the visit
 * where they were taken (Redis `field:completion:{eventId}`, blob URLs
 * inside) — there is no customer index. So the collector finds the
 * customer's past calendar events first (name match with spelling-drift
 * tolerance, or address match: "Rachel" vs "Rachael McCarthy" is the
 * live example), then reads each visit's completion record.
 *
 * Same contract as the other photo sources: every failure logs and
 * degrades to fewer/zero photos, never blocks stub creation. The package
 * stays pure — the Redis lookup and blob download are injected deps.
 */

import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { createLogger } from '@aac/shared-utils/logger';
import {
  uploadPhotoAttachments,
  type PhotoUploadItem,
  type StubPhotoAttachment,
} from './stub-photos.js';

const log = createLogger('scheduling:field-photos');

/** Mirrors apps/field CompletionPhoto — the subset this collector reads. */
export interface FieldCompletionPhoto {
  url: string;
  label: string;
  takenAt: string;
  kind?: 'image' | 'video';
}

export interface FieldCompletionRecord {
  photos?: FieldCompletionPhoto[];
}

export interface CollectFieldPhotosDeps {
  cal: GoogleCalendarClient;
  drive: GoogleDriveClient;
  /** App-injected lookup of `field:completion:{calendarEventId}`. */
  fetchCompletion: (calendarEventId: string) => Promise<FieldCompletionRecord | null>;
  /** Blob download; defaults to fetch restricted to Vercel Blob hosts. */
  download?: (url: string) => Promise<{ data: Buffer; contentType: string | null } | null>;
  now: () => Date;
}

export interface CollectFieldPhotosInput {
  customerName: string;
  customerAddress?: string | null;
  /** Drive read access granted to these emails (Mike) — no notification. */
  shareWithEmails: string[];
  /** Cap on photos attached (default 6, most recent kept). */
  maxPhotos?: number;
  /** How far back to scan the calendar for visits (default 270 days). */
  lookbackDays?: number;
  /** Drive folder the uploads land in (created if missing). */
  folderName?: string;
}

const DEFAULT_MAX_PHOTOS = 6;
const DEFAULT_LOOKBACK_DAYS = 270;
/** Visits to actually read completion records for (most recent first). */
const MAX_VISITS = 4;

async function downloadBlob(
  url: string,
): Promise<{ data: Buffer; contentType: string | null } | null> {
  const host = new URL(url).hostname;
  if (!host.endsWith('.public.blob.vercel-storage.com')) {
    throw new Error(`Refusing to download field photo from non-Blob host: ${host}`);
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  };
}

function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/^(stub|hold)\s+—\s+/, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tolerant person-name match: same surname plus given names that share a
 * 4-char prefix ("rachel"/"rachael"); single-token names must be equal.
 */
export function customerNameMatches(eventSummary: string, customerName: string): boolean {
  const a = nameTokens(eventSummary);
  const b = nameTokens(customerName);
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length < 2 || b.length < 2) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false;
  const [givenA, givenB] = [a[0], b[0]];
  const prefix = Math.min(4, givenA.length, givenB.length);
  return givenA.slice(0, prefix) === givenB.slice(0, prefix);
}

/**
 * Loose street-address match: same leading street number and same first
 * street-name word ("122 Allen Avenue, Falmouth" vs "122 Allen Ave, …").
 */
export function addressMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const parse = (s: string): { num: string; street: string } | null => {
    const m = s.toLowerCase().match(/(\d+)\s+([a-z]+)/);
    return m ? { num: m[1], street: m[2] } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  return Boolean(pa && pb && pa.num === pb.num && pa.street === pb.street);
}

export async function collectFieldPhotoAttachments(
  deps: CollectFieldPhotosDeps,
  input: CollectFieldPhotosInput,
): Promise<StubPhotoAttachment[]> {
  const maxPhotos = input.maxPhotos ?? DEFAULT_MAX_PHOTOS;
  const nowMs = deps.now().getTime();
  const download = deps.download ?? downloadBlob;

  try {
    const events = await deps.cal.listEvents({
      timeMin: new Date(nowMs - (input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000)
        .toISOString(),
      timeMax: new Date(nowMs).toISOString(),
    });

    const visits = events
      .filter((e: CalendarEvent) => new Date(e.end).getTime() <= nowMs)
      .filter(
        (e: CalendarEvent) =>
          customerNameMatches(e.summary ?? '', input.customerName) ||
          addressMatches(e.location, input.customerAddress),
      )
      .sort((a: CalendarEvent, b: CalendarEvent) => b.start.localeCompare(a.start))
      .slice(0, MAX_VISITS);

    const photos: FieldCompletionPhoto[] = [];
    for (const visit of visits) {
      const record = await deps.fetchCompletion(visit.id);
      for (const p of record?.photos ?? []) {
        if (p.kind !== 'video') photos.push(p);
      }
    }
    // Most recent photos carry the most context; keep the newest maxPhotos.
    const candidates = photos
      .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
      .slice(-maxPhotos);
    if (candidates.length === 0) return [];

    const items: PhotoUploadItem[] = [];
    for (const [i, photo] of candidates.entries()) {
      try {
        const downloaded = await download(photo.url);
        if (!downloaded) {
          log.warn('Field photo download returned non-OK — skipping', { url: photo.url });
          continue;
        }
        const base = new URL(photo.url).pathname.split('/').pop() || `field-photo-${i + 1}.jpg`;
        items.push({
          data: downloaded.data,
          mimeType: downloaded.contentType ?? 'image/jpeg',
          name: base,
        });
      } catch (err) {
        log.warn('Field photo download failed — skipping photo', {
          url: photo.url,
          error: (err as Error).message,
        });
      }
    }

    const attachments = await uploadPhotoAttachments(deps.drive, {
      items,
      shareWithEmails: input.shareWithEmails,
      folderName: input.folderName,
    });

    log.info('Field photos collected', {
      customerName: input.customerName,
      visits: visits.length,
      candidates: candidates.length,
      attached: attachments.length,
    });
    return attachments;
  } catch (err) {
    log.warn('Field photo collection failed — continuing without photos', {
      customerName: input.customerName,
      error: (err as Error).message,
    });
    return [];
  }
}
