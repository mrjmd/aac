import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCalendar } from '@/lib/clients';
import { getCompletion } from '@/lib/completion';
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
