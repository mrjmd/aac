import Link from 'next/link';
import SwipeDayNavigator from './swipe-day-navigator';
import { getCalendar } from '@/lib/clients';
import { getEnv } from '@/lib/env';
import {
  getTodayEasternDate,
  getEasternRangeForDate,
  formatEventTimeRange,
  formatDateDisplay,
  shiftDate,
  isValidDateLabel,
} from '@/lib/dates';
import { classifyEvent, labelForType, badgeColorClasses } from '@/lib/event-classification';
import { buildDirectionsUrl } from '@/lib/location';
import { resolveEventCity } from '@/lib/event-city';
import { resolveTravelLegs, formatDuration, formatDistance, type DayTravel } from '@/lib/travel-time';

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
  let citiesByEventId: Record<string, string | null> = {};
  let travel: DayTravel = { byEvent: new Map(), backHome: null };
  try {
    const env = getEnv();
    const { timeMin, timeMax } = getEasternRangeForDate(dateLabel);
    events = await getCalendar().listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.technicianEmails,
    });
    // Resolve cities + drive-time legs in parallel — both are cached in Redis
    // so the first load of a day is the slow one; subsequent loads are instant.
    const [cityPairs, resolvedTravel] = await Promise.all([
      Promise.all(events.map(async (evt) => [evt.id, await resolveEventCity(evt)] as const)),
      resolveTravelLegs(events),
    ]);
    citiesByEventId = Object.fromEntries(cityPairs);
    travel = resolvedTravel;
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
              <Link href="/" className="text-xs text-aac-blue underline">
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
            {events.map((evt, idx) => {
              const type = classifyEvent(evt.colorId);
              const city = citiesByEventId[evt.id];
              const leg = travel.byEvent.get(evt.id);
              const prevEvent = idx > 0 ? events[idx - 1] : null;
              const gapSec = prevEvent
                ? Math.round((new Date(evt.start).getTime() - new Date(prevEvent.end).getTime()) / 1000)
                : null;
              const tight = leg && gapSec !== null && gapSec < leg.durationSec;
              return (
                <li key={evt.id} className="relative">
                  {leg && (
                    <div
                      className={`mb-1 flex items-center gap-1.5 px-1 text-xs ${
                        tight ? 'text-red-700' : 'text-zinc-500'
                      }`}
                    >
                      <CarIcon className="h-3.5 w-3.5" />
                      <span>
                        {leg.fromHome ? 'from home — ' : ''}
                        {formatDuration(leg.durationSec)}
                        <span className="text-zinc-400"> · {formatDistance(leg.distanceMeters)}</span>
                        {tight && gapSec !== null && (
                          <span className="ml-1 font-medium">
                            ⚠ only {formatDuration(Math.max(gapSec, 0))} gap
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  <Link
                    href={`/events/${evt.id}?from=${dateLabel}`}
                    className="block rounded-lg border border-zinc-200 bg-white p-4 shadow-sm active:bg-zinc-50"
                  >
                    <div className="mb-1 flex items-start justify-between gap-3 pr-12">
                      <h2 className="text-base font-medium leading-snug">
                        {evt.summary || '(untitled)'}
                      </h2>
                      <span
                        className={`inline-block shrink-0 rounded border px-2 py-0.5 text-xs font-medium ${badgeColorClasses(type)}`}
                      >
                        {labelForType(type)}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-600">
                      {formatEventTimeRange(evt.start, evt.end)}
                    </p>
                    {city && (
                      <p className="mt-1 text-sm text-zinc-500">{city}</p>
                    )}
                  </Link>
                  {evt.location && (
                    <a
                      href={buildDirectionsUrl(evt.location)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open directions to ${city ?? evt.location}`}
                      className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md border border-aac-blue/20 bg-white text-aac-blue shadow-sm active:bg-aac-blue/5"
                    >
                      <PinIcon className="h-5 w-5" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {travel.backHome && (
          <div className="mt-2 flex items-center gap-1.5 px-1 text-xs text-zinc-500">
            <CarIcon className="h-3.5 w-3.5" />
            <span>
              back home — {formatDuration(travel.backHome.durationSec)}
              <span className="text-zinc-400"> · {formatDistance(travel.backHome.distanceMeters)}</span>
            </span>
          </div>
        )}
      </section>
    </main>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2C7.6 2 4 5.6 4 10c0 5.4 7 11.6 7.3 11.9.2.1.5.1.7 0C12.3 21.6 20 15.4 20 10c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z" />
    </svg>
  );
}

function CarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11h.5a1.5 1.5 0 011.5 1.5V17a1 1 0 01-1 1h-1a1 1 0 01-1-1v-1H6v1a1 1 0 01-1 1H4a1 1 0 01-1-1v-4.5A1.5 1.5 0 014.5 11H5zm2.1 0h9.8l-1.05-3.15A.5.5 0 0015.4 7.5H8.6a.5.5 0 00-.47.35L7.1 11zm-.6 3.5a1 1 0 100-2 1 1 0 000 2zm11 0a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  );
}
