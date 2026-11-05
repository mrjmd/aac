/**
 * Date helpers for "today in Eastern time" — Mike's local time.
 */

export function getTodayEasternDate(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = nowET.getFullYear();
  const m = String(nowET.getMonth() + 1).padStart(2, '0');
  const d = String(nowET.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Eastern UTC offset ("-04:00" EDT / "-05:00" EST) in effect at noon on the date. */
export function easternOffset(dateLabel: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(`${dateLabel}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value; // "GMT-5"
  const hours = Number(name?.match(/GMT([+-]\d+)/)?.[1] ?? -5);
  return `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

export function getEasternRangeForDate(dateLabel: string): { timeMin: string; timeMax: string; dateLabel: string } {
  const off = easternOffset(dateLabel);
  return {
    timeMin: `${dateLabel}T00:00:00${off}`,
    timeMax: `${dateLabel}T23:59:59${off}`,
    dateLabel,
  };
}

export function shiftDate(dateLabel: string, days: number): string {
  const [y, m, d] = dateLabel.split('-').map(Number);
  // Use UTC math to avoid local-tz drift; we only care about the date label.
  const t = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  const next = new Date(t);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function isValidDateLabel(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function formatDateDisplay(dateLabel: string): string {
  // Parse as noon ET to avoid DST/timezone edge cases when formatting
  const [y, m, d] = dateLabel.split('-').map(Number);
  const noonET = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // noon ET ≈ 16:00 UTC (EDT)
  return noonET.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

export function formatEventTime(isoDateTime: string): string {
  return new Date(isoDateTime).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
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
    timeZone: 'America/New_York',
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
    timeZone: 'America/New_York',
  });
}
