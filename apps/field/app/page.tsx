import Link from 'next/link';
import SwipeDayNavigator from './swipe-day-navigator';
import { getCalendar } from '@/lib/clients';
import { getEnv } from '@/lib/env';
import {
  getTodayEasternDate,
  getEasternRangeForDate,
  formatEventTime,
  formatDateDisplay,
  shiftDate,
  isValidDateLabel,
} from '@/lib/dates';
import { classifyEvent, labelForType, badgeColorClasses } from '@/lib/event-classification';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ date?: string }>;
}

export default async function DayPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const today = getTodayEasternDate();
  const dateLabel =
    params.date && isValidDateLabel(params.date) ? params.date : today;

  let events: Awaited<ReturnType<ReturnType<typeof getCalendar>['listEvents']>> = [];
  let loadError: string | null = null;
  try {
    const env = getEnv();
    const { timeMin, timeMax } = getEasternRangeForDate(dateLabel);
    events = await getCalendar().listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.technicianEmails,
    });
  } catch (err) {
    console.error('Failed to load calendar for', dateLabel, err);
    loadError = err instanceof Error ? err.message : String(err);
  }

  const prevDate = shiftDate(dateLabel, -1);
  const nextDate = shiftDate(dateLabel, 1);
  const isToday = dateLabel === today;

  return (
    <main className="min-h-dvh">
      <SwipeDayNavigator prevHref={`/?date=${prevDate}`} nextHref={`/?date=${nextDate}`} />
      <header className="px-3 pt-4 pb-3 border-b border-zinc-200 bg-white sticky top-0 z-10">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/?date=${prevDate}`}
            aria-label="Previous day"
            className="rounded-md border border-zinc-300 px-3 py-2 text-xl leading-none active:bg-zinc-100"
          >
            ‹
          </Link>
          <div className="text-center flex-1">
            <h1 className="text-lg font-semibold tracking-tight leading-tight">
              {isToday ? 'Today' : formatDateDisplay(dateLabel)}
            </h1>
            {isToday ? (
              <p className="text-xs text-zinc-500">{formatDateDisplay(dateLabel)}</p>
            ) : (
              <Link href="/" className="text-xs text-blue-600 underline">
                jump to today
              </Link>
            )}
          </div>
          <Link
            href={`/?date=${nextDate}`}
            aria-label="Next day"
            className="rounded-md border border-zinc-300 px-3 py-2 text-xl leading-none active:bg-zinc-100"
          >
            ›
          </Link>
        </div>
      </header>

      <section className="px-3 py-3">
        {loadError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
            <p className="font-medium">Couldn&apos;t load events</p>
            <p className="text-xs mt-1 text-red-700">{loadError}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="text-center text-zinc-500 py-12">
            <p className="text-base">No events scheduled.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {events.map((evt) => {
              const type = classifyEvent(evt.colorId);
              return (
                <li key={evt.id}>
                  <Link
                    href={`/events/${evt.id}?from=${dateLabel}`}
                    className="block bg-white rounded-lg border border-zinc-200 p-4 shadow-sm active:bg-zinc-50"
                  >
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <h2 className="font-medium text-base leading-snug">
                        {evt.summary || '(untitled)'}
                      </h2>
                      <span
                        className={`shrink-0 inline-block text-xs font-medium px-2 py-0.5 rounded border ${badgeColorClasses(type)}`}
                      >
                        {labelForType(type)}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-600">
                      {formatEventTime(evt.start)}
                    </p>
                    {evt.location && (
                      <p className="text-sm text-zinc-500 mt-1 truncate">
                        {evt.location}
                      </p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
