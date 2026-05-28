import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { normalizePhone } from '@aac/shared-utils/phone';
import { getCalendar, getPipedrive } from '@/lib/clients';
import { getCompletion } from '@/lib/completion';
import { matchEventToPerson } from '@/lib/customer-match';
import { extractDriveFileId, getDriveInfos, thumbnailUrl } from '@/lib/drive';
import { getEnv } from '@/lib/env';
import { formatEventTime, formatDateDisplay } from '@/lib/dates';
import { classifyEvent, labelForType, badgeColorClasses } from '@/lib/event-classification';
import CompletionChecklist from './completion-flow';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

function dateLabelFromISO(iso: string): string {
  const d = new Date(iso);
  const y = d.toLocaleString('en-CA', { year: 'numeric', timeZone: 'America/New_York' });
  const m = d.toLocaleString('en-CA', { month: '2-digit', timeZone: 'America/New_York' });
  const day = d.toLocaleString('en-CA', { day: '2-digit', timeZone: 'America/New_York' });
  return `${y}-${m}-${day}`;
}

export default async function EventDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { from } = await searchParams;

  let evt: Awaited<ReturnType<ReturnType<typeof getCalendar>['getEvent']>> | null = null;
  let loadError: string | null = null;
  try {
    evt = await getCalendar().getEvent(id);
  } catch (err) {
    if ((err as { code?: number })?.code === 404) {
      notFound();
    }
    console.error('Failed to load event', id, err);
    loadError = err instanceof Error ? err.message : String(err);
  }

  const backHref = from ? `/?date=${from}` : '/';

  if (loadError || !evt) {
    return (
      <main className="min-h-dvh">
        <header className="px-3 pt-4 pb-3 border-b border-zinc-200 bg-white">
          <Link href={backHref} className="text-sm text-aac-blue">
            ‹ Back
          </Link>
        </header>
        <section className="px-3 py-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
            <p className="font-medium">Couldn&apos;t load event</p>
            {loadError && <p className="text-xs mt-1 text-red-700">{loadError}</p>}
          </div>
        </section>
      </main>
    );
  }

  const type = classifyEvent(evt.colorId);
  const eventDateLabel = dateLabelFromISO(evt.start);
  const completion = await getCompletion(id);
  const env = getEnv();

  // Resolve the PD person so we can surface call/text actions on the
  // customer's name. Only attempt for job/inspection-shaped events; skip
  // for personal/admin entries (and swallow PD failures — phone buttons
  // are nice-to-have, not blocking).
  let customerPhoneE164: string | null = null;
  if (type !== 'other') {
    try {
      const person = await matchEventToPerson(evt, getPipedrive());
      const raw = person ? PipedriveClient.getPrimaryPhone(person) : null;
      customerPhoneE164 = raw ? normalizePhone(raw) : null;
    } catch (err) {
      console.error('PD lookup for event failed', id, err);
    }
  }

  // Resolve calendar attachments → Drive metadata so we can filter out tech
  // uploads (only show context photos Matt pre-attached) and use Drive's
  // signed thumbnail URLs (which work on Mike's phone without him being
  // logged into Matt's Google account).
  const imageAttachments = evt.attachments.filter(
    (a) => a.mimeType?.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(a.title),
  );
  const fileIds = imageAttachments
    .map((a) => extractDriveFileId(a.fileUrl))
    .filter((id): id is string => !!id);
  const infos = await getDriveInfos(fileIds);

  const techEmails = new Set(env.technicianEmails);
  const contextPhotos = imageAttachments
    .map((a) => ({ attachment: a, info: infos.get(extractDriveFileId(a.fileUrl) || '') ?? null }))
    .filter(({ info }) => {
      // Drop anything we couldn't enrich, AND anything uploaded by a tech.
      if (!info) return false;
      const owner = info.ownerEmail?.toLowerCase() ?? '';
      const editor = info.lastModifiedByEmail?.toLowerCase() ?? '';
      return !techEmails.has(owner) && !techEmails.has(editor);
    });

  return (
    <main className="min-h-dvh">
      <header className="px-3 pt-4 pb-3 border-b border-zinc-200 bg-white sticky top-0 z-10">
        <Link
          href={from ? `/?date=${from}` : `/?date=${eventDateLabel}`}
          className="text-sm text-aac-blue inline-flex items-center"
        >
          <span className="text-lg leading-none mr-1">‹</span>
          Back
        </Link>
      </header>

      <section className="px-4 py-5 space-y-5">
        <div>
          <div className="flex items-start justify-between gap-3 mb-2">
            <h1 className="text-2xl font-semibold leading-tight">
              {evt.summary || '(untitled)'}
            </h1>
            <span
              className={`shrink-0 inline-block text-xs font-medium px-2 py-0.5 rounded border ${badgeColorClasses(type)}`}
            >
              {labelForType(type)}
            </span>
          </div>
          {customerPhoneE164 && (
            <div className="mb-2 flex gap-2">
              <a
                href={`tel:${customerPhoneE164}`}
                aria-label={`Call ${evt.summary || 'customer'}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-aac-blue/30 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5"
              >
                <PhoneIcon className="h-3.5 w-3.5" />
                Call
              </a>
              <a
                href={`sms:${customerPhoneE164}`}
                aria-label={`Text ${evt.summary || 'customer'}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-aac-blue/30 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-aac-blue active:bg-aac-blue/5"
              >
                <ChatIcon className="h-3.5 w-3.5" />
                Text
              </a>
            </div>
          )}
          <p className="text-base text-zinc-700">
            {formatDateDisplay(eventDateLabel)} · {formatEventTime(evt.start)}
            {evt.end && (() => {
              const startTime = formatEventTime(evt.start);
              const endTime = formatEventTime(evt.end);
              return endTime !== startTime ? ` – ${endTime}` : '';
            })()}
          </p>
        </div>

        {evt.location && (
          <DetailRow label="Location">
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(evt.location)}`}
              target="_blank"
              rel="noreferrer"
              className="text-aac-blue underline break-words"
            >
              {evt.location}
            </a>
          </DetailRow>
        )}

        {evt.description && (
          <DetailRow label="Notes">
            <p className="text-zinc-700 whitespace-pre-wrap text-sm">{evt.description}</p>
          </DetailRow>
        )}

        {contextPhotos.length > 0 && (
          <DetailRow label={`Job context (${contextPhotos.length})`}>
            <ul className="grid grid-cols-3 gap-2">
              {contextPhotos.map(({ attachment, info }) => {
                const thumb = info ? thumbnailUrl(info, 400) : undefined;
                return (
                  <li key={attachment.fileUrl}>
                    <a
                      href={attachment.fileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block aspect-square rounded-md overflow-hidden bg-zinc-100 border border-zinc-200"
                      title={attachment.title}
                    >
                      {thumb ? (
                        // Plain <img>: googleusercontent.com is signed +
                        // public, no next/image domain config needed.
                        <img
                          src={thumb}
                          alt={attachment.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-xs text-zinc-500 px-2 text-center">
                          {attachment.title}
                        </div>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-zinc-500 mt-2">Tap a thumbnail to view in Drive.</p>
          </DetailRow>
        )}

        <div className="pt-2 border-t border-zinc-200">
          <h2 className="text-lg font-semibold mb-3 mt-4">
            {completion?.phase === 'completed'
              ? 'Done'
              : completion === null
                ? `Start this ${labelForType(type).toLowerCase()}`
                : `Continue this ${labelForType(type).toLowerCase()}`}
          </h2>
          <CompletionChecklist eventId={id} eventType={type} completion={completion} />
        </div>
      </section>
    </main>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1">
        {label}
      </p>
      <div className="text-base">{children}</div>
    </div>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2z" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-4H6V8h12v2zm0-4H6V4h12v2z" />
    </svg>
  );
}
