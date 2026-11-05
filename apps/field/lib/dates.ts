/**
 * Display formatting in Eastern time (Mike's local time). Day math lives
 * in @aac/shared-utils/eastern.
 */

import { EASTERN_TZ, easternWallTime } from '@aac/shared-utils/eastern';

export function formatDateDisplay(dateLabel: string): string {
  return easternWallTime(dateLabel, 12).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: EASTERN_TZ,
  });
}

export function formatEventTime(isoDateTime: string): string {
  return new Date(isoDateTime).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: EASTERN_TZ,
  });
}

/** "9:00 AM – 11:30 AM" — drops the AM/PM on start if the range stays in one period. */
export function formatEventTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const opts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: EASTERN_TZ,
  };
  const startStr = start.toLocaleTimeString('en-US', opts);
  const endStr = end.toLocaleTimeString('en-US', opts);
  const startPeriod = startStr.slice(-2);
  const endPeriod = endStr.slice(-2);
  if (startPeriod === endPeriod) {
    return `${startStr.replace(/\s?(AM|PM)$/, '')} – ${endStr}`;
  }
  return `${startStr} – ${endStr}`;
}

export function formatTodayDisplay(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: EASTERN_TZ,
  });
}
