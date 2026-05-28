import { Fragment } from 'react';
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
import { getCurrentSession } from '@/lib/session';
import { getUserConfig } from '@/lib/user-config';

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
    const session = await getCurrentSession();
    const userConfig = session ? await getUserConfig(session.email) : { homeAddress: null };
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
      resolveTravelLegs(events, { homeAddress: userConfig.homeAddress }),
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
      <header className="sticky top-0 z-10 border-b border-aac-blue/20 bg-white/95 px-3 pt-4 pb-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/?date=${prevDate}`}
            aria-label="Previous day"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-aac-blue/30 text-xl leading-none text-aac-blue active:bg-aac-blue/5"
          >
            ‹
          </Link>
          <div className="flex-1 text-center">
            <h1 className="font-display text-lg font-bold tracking-tight leading-tight text-aac-dark">
              {isToday ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-aac-yellow shadow-[0_0_0_3px_rgba(240,195,75,0.25)]" />
                  Today
                </span>
              ) : (
                formatDateDisplay(dateLabel)
              )}
            </h1>
            {isToday ? (
              <p className="text-xs text-zinc-500">{formatDateDisplay(dateLabel)}</p>
            ) : (
              <Link href="/" className="text-xs font-medium text-aac-blue underline-offset-2 hover:underline">
                jump to today
              </Link>
            )}
          </div>
          <Link
            href={`/?date=${nextDate}`}
            aria-label="Next day"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-aac-blue/30 text-xl leading-none text-aac-blue active:bg-aac-blue/5"
          >
            ›
          </Link>
        </div>
      </header>

      <section className="px-3 py-4">
        {loadError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-medium">Couldn&apos;t load events</p>
            <p className="mt-1 text-xs text-red-700">{loadError}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="py-12 text-center text-zinc-500">
            <p className="text-base">No events scheduled.</p>
          </div>
        ) : (
          <div>
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
                <Fragment key={evt.id}>
                  {leg && (
                    <>
                      {idx > 0 && <Rail />}
                      <DriveChip
                        durationSec={leg.durationSec}
                        distanceMeters={leg.distanceMeters}
                        variant={leg.fromHome ? 'home' : 'midway'}
                        warning={tight ? `only ${formatDuration(Math.max(gapSec ?? 0, 0))} gap` : null}
                      />
                      <Rail />
                    </>
                  )}
                  <EventCard
                    href={`/events/${evt.id}?from=${dateLabel}`}
                    summary={evt.summary || '(untitled)'}
                    typeLabel={labelForType(type)}
                    typeBadge={badgeColorClasses(type)}
                    timeRange={formatEventTimeRange(evt.start, evt.end)}
                    city={city}
                    location={evt.location}
                  />
                </Fragment>
              );
            })}
            {travel.backHome && (
              <>
                <Rail />
                <DriveChip
                  durationSec={travel.backHome.durationSec}
                  distanceMeters={travel.backHome.distanceMeters}
                  variant="home"
                  backHome
                  warning={null}
                />
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function EventCard({
  href,
  summary,
  typeLabel,
  typeBadge,
  timeRange,
  city,
  location,
}: {
  href: string;
  summary: string;
  typeLabel: string;
  typeBadge: string;
  timeRange: string;
  city: string | null | undefined;
  location: string | undefined;
}) {
  return (
    <div className="relative">
      <Link
        href={href}
        className="block rounded-lg border border-l-4 border-zinc-200 border-l-aac-blue bg-white p-4 shadow-sm transition-shadow hover:shadow active:bg-zinc-50"
      >
        <div className="mb-1 flex items-start justify-between gap-3 pr-12">
          <h2 className="font-display text-base font-semibold leading-snug tracking-tight text-aac-dark">
            {summary}
          </h2>
          <span
            className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${typeBadge}`}
          >
            {typeLabel}
          </span>
        </div>
        <p className="text-sm font-medium text-zinc-700">{timeRange}</p>
        {city && <p className="mt-1 text-sm text-zinc-500">{city}</p>}
      </Link>
      {location && (
        <a
          href={buildDirectionsUrl(location)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open directions to ${city ?? location}`}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md bg-aac-blue text-white shadow-sm active:bg-aac-blue/85"
        >
          <PinIcon className="h-5 w-5" />
        </a>
      )}
    </div>
  );
}

function Rail() {
  return <div className="mx-auto h-4 w-0.5 bg-aac-blue/30" aria-hidden />;
}

function DriveChip({
  durationSec,
  distanceMeters,
  variant,
  warning,
  backHome = false,
}: {
  durationSec: number;
  distanceMeters: number;
  variant: 'home' | 'midway';
  warning: string | null;
  backHome?: boolean;
}) {
  const isHome = variant === 'home';
  const wrapperClass = warning
    ? 'border-red-300 bg-red-50 text-red-700'
    : 'border-aac-blue/30 bg-white text-aac-blue';
  const dividerClass = warning ? 'text-red-400' : 'text-aac-blue/50';
  const iconWrapClass = warning
    ? 'text-red-500'
    : isHome
      ? 'text-aac-yellow'
      : 'text-aac-blue';

  return (
    <div className="flex justify-center">
      <div
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm ${wrapperClass}`}
      >
        <span className={iconWrapClass}>
          {isHome ? <HomeIcon className="h-3.5 w-3.5" /> : <CarIcon className="h-3.5 w-3.5" />}
        </span>
        <span className="font-semibold tracking-tight">
          {isHome ? (backHome ? 'back home — ' : 'from home — ') : ''}
          {formatDuration(durationSec)}
        </span>
        <span className={dividerClass}>·</span>
        <span className="font-medium">{formatDistance(distanceMeters)}</span>
        {warning && (
          <>
            <span className={dividerClass}>·</span>
            <span className="font-semibold">⚠ {warning}</span>
          </>
        )}
      </div>
    </div>
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

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.2 3 11h2v9h5v-6h4v6h5v-9h2L12 3.2z" />
    </svg>
  );
}
