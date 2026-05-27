/**
 * Date helpers for "today in Eastern time" — Mike's local time.
 *
 * NOTE: hardcodes -04:00 (EDT). Acceptable for now since AAC operates
 * in MA and EDT covers most of the year. TODO: handle DST transitions
 * via shortOffset detection when we cross into EST (early November).
 */

export function getTodayEasternDate(): string {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = nowET.getFullYear();
  const m = String(nowET.getMonth() + 1).padStart(2, '0');
  const d = String(nowET.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getEasternRangeForDate(dateLabel: string): { timeMin: string; timeMax: string; dateLabel: string } {
  return {
    timeMin: `${dateLabel}T00:00:00-04:00`,
    timeMax: `${dateLabel}T23:59:59-04:00`,
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

export function formatTodayDisplay(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}
