import type { Scorecard } from "@aac/metrics";

/** What This week's scorecard gets: no per-cell records (they load on click from /api/scorecard/records), and whether the snapshot has them. */
export type ScorecardView = Scorecard & { drill: boolean };

export function withoutRecords(card: Scorecard | null): ScorecardView | null {
  if (!card) return null;
  const rows = card.rows.map((r) => {
    const row = { ...r };
    delete row.records;
    delete row.lastYearRecords;
    return row;
  });
  return { ...card, drill: !!card.rows[0]?.records, rows };
}
