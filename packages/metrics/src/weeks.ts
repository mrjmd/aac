/** Monday-to-Sunday weeks on YYYY-MM-DD dates (America/New_York days). */
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 0 Sun .. 6 Sat. */
export const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
export const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
