/**
 * collectEmailPhotoAttachments — pull image attachments the customer
 * emailed (the MMS-bounce fallback: carriers reject large photos, Matt
 * says "email them instead") and turn them into stub-event attachments.
 *
 * Needs the customer's email address(es) — resolved by the caller from
 * the PD person — and a GmailClient whose token carries gmail.readonly.
 * Same contract as the other photo sources: every failure logs and
 * degrades to fewer/zero photos, never blocks stub creation.
 */

import type { GmailClient, GmailMessage } from '@aac/api-clients/gmail';
import type { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { createLogger } from '@aac/shared-utils/logger';
import {
  uploadPhotoAttachments,
  type PhotoUploadItem,
  type StubPhotoAttachment,
} from './stub-photos.js';

const log = createLogger('scheduling:email-photos');

export interface CollectEmailPhotosDeps {
  gmail: GmailClient;
  drive: GoogleDriveClient;
  now: () => Date;
}

export interface CollectEmailPhotosInput {
  /** Customer addresses to search as senders (PD person emails). */
  customerEmails: string[];
  /** Drive read access granted to these emails (Mike) — no notification. */
  shareWithEmails: string[];
  /** Cap on photos attached (default 6, most recent kept). */
  maxPhotos?: number;
  /** How far back to search (default 60 days). */
  sinceDays?: number;
  /** Drive folder the uploads land in (created if missing). */
  folderName?: string;
}

const DEFAULT_MAX_PHOTOS = 6;
const DEFAULT_SINCE_DAYS = 60;
const MESSAGE_SCAN_LIMIT = 20;

export async function collectEmailPhotoAttachments(
  deps: CollectEmailPhotosDeps,
  input: CollectEmailPhotosInput,
): Promise<StubPhotoAttachment[]> {
  const maxPhotos = input.maxPhotos ?? DEFAULT_MAX_PHOTOS;
  const emails = input.customerEmails.map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) return [];

  try {
    const fromClause =
      emails.length === 1
        ? `from:${emails[0]}`
        : `(${emails.map((e) => `from:${e}`).join(' OR ')})`;
    const messages = await deps.gmail.listMessages({
      query: `${fromClause} has:attachment newer_than:${input.sinceDays ?? DEFAULT_SINCE_DAYS}d`,
      maxResults: MESSAGE_SCAN_LIMIT,
    });

    // Oldest first, then keep the most recent maxPhotos across messages —
    // same recency rule as the Quo and field sources.
    const candidates = [...messages]
      .sort((a: GmailMessage, b: GmailMessage) => a.at.localeCompare(b.at))
      .flatMap((m) =>
        m.attachments
          .filter((a) => a.mimeType.startsWith('image/'))
          .map((a) => ({ messageId: m.id, ...a })),
      )
      .slice(-maxPhotos);
    if (candidates.length === 0) return [];

    const items: PhotoUploadItem[] = [];
    for (const att of candidates) {
      try {
        const data = await deps.gmail.downloadAttachment(att.messageId, att.attachmentId);
        if (!data) {
          log.warn('Email photo download returned no data — skipping', {
            filename: att.filename,
          });
          continue;
        }
        items.push({ data, mimeType: att.mimeType, name: att.filename });
      } catch (err) {
        log.warn('Email photo download failed — skipping photo', {
          filename: att.filename,
          error: (err as Error).message,
        });
      }
    }

    const attachments = await uploadPhotoAttachments(deps.drive, {
      items,
      shareWithEmails: input.shareWithEmails,
      folderName: input.folderName,
    });

    log.info('Email photos collected', {
      customerEmails: emails,
      candidates: candidates.length,
      attached: attachments.length,
    });
    return attachments;
  } catch (err) {
    log.warn('Email photo collection failed — continuing without photos', {
      customerEmails: emails,
      error: (err as Error).message,
    });
    return [];
  }
}
