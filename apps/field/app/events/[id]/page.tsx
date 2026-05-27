import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCalendar } from '@/lib/clients';
import { getCompletion } from '@/lib/completion';
import { formatEventTime, formatDateDisplay } from '@/lib/dates';
import { classifyEvent, labelForType, badgeColorClasses } from '@/lib/event-classification';
import CompletionFlow from './completion-flow';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

function dateLabelFromISO(iso: string): string {
  // Take the date portion in ET (event.start is full ISO with offset)
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
          <Link href={backHref} className="text-sm text-blue-600">
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

  return (
    <main className="min-h-dvh">
      <header className="px-3 pt-4 pb-3 border-b border-zinc-200 bg-white sticky top-0 z-10">
        <Link
          href={from ? `/?date=${from}` : `/?date=${eventDateLabel}`}
          className="text-sm text-blue-600 inline-flex items-center"
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
              // Show end time if different from start
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
              className="text-blue-600 underline break-words"
            >
              {evt.location}
            </a>
          </DetailRow>
        )}

        {evt.attendees.length > 0 && (
          <DetailRow label="Attendees">
            <ul className="space-y-1">
              {evt.attendees.map((a) => (
                <li key={a} className="text-zinc-700 break-all">{a}</li>
              ))}
            </ul>
          </DetailRow>
        )}

        {evt.description && (
          <DetailRow label="Notes">
            <p className="text-zinc-700 whitespace-pre-wrap text-sm">{evt.description}</p>
          </DetailRow>
        )}

        <div className="pt-2 border-t border-zinc-200">
          <h2 className="text-lg font-semibold mb-3 mt-4">
            {completion?.phase === 'completed'
              ? 'Completed'
              : completion === null
                ? `Start this ${labelForType(type).toLowerCase()}`
                : `Continue this ${labelForType(type).toLowerCase()}`}
          </h2>
          {completion?.phase === 'completed' ? (
            <CompletedView completion={completion} />
          ) : (
            <CompletionFlow eventId={id} eventType={type} completion={completion} />
          )}
        </div>
      </section>
    </main>
  );
}

function CompletedView({
  completion,
}: {
  completion: NonNullable<Awaited<ReturnType<typeof getCompletion>>>;
}) {
  const completedAt = new Date(completion.completedAt ?? completion.checkedInAt);
  const completedAtFmt = completedAt.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
  return (
    <div className="space-y-4 mt-4">
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
        <p className="font-semibold text-emerald-900">✓ Completed</p>
        <p className="text-sm text-emerald-800 mt-1">{completedAtFmt}</p>
        {completion.paymentStatus && (
          <p className="text-sm text-emerald-800 mt-1">
            Payment: <span className="font-medium">{labelForPayment(completion.paymentStatus)}</span>
          </p>
        )}
        {completion.checkInLocation && (
          <p className="text-sm text-emerald-800 mt-1">
            Check-in location:{' '}
            <a
              href={`https://www.google.com/maps?q=${completion.checkInLocation.latitude},${completion.checkInLocation.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              view on map
            </a>{' '}
            <span className="text-xs text-emerald-700">
              (±{Math.round(completion.checkInLocation.accuracy)}m)
            </span>
          </p>
        )}
        {!completion.checkInLocation && completion.checkInLocationError && (
          <p className="text-xs text-emerald-700 mt-1">
            GPS unavailable at check-in ({completion.checkInLocationError})
          </p>
        )}
        {completion.note && (
          <p className="text-sm text-emerald-900 mt-2 whitespace-pre-wrap">
            “{completion.note}”
          </p>
        )}
      </div>

      {completion.photos.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">Photos</p>
          <div className="grid grid-cols-2 gap-2">
            {completion.photos.map((p) => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="block bg-zinc-100 rounded-lg overflow-hidden aspect-square relative"
              >
                <Image
                  src={p.url}
                  alt={p.label}
                  fill
                  sizes="(max-width: 640px) 50vw, 240px"
                  className="object-cover"
                />
                <span className="absolute bottom-1 left-1 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
                  {p.label}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function labelForPayment(s: string): string {
  switch (s) {
    case 'cash': return 'Cash';
    case 'check': return 'Check';
    case 'card': return 'Card';
    case 'not_yet_paid': return 'Not Yet Paid (invoice sent)';
    default: return s;
  }
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
