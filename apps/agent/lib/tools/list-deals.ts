/**
 * Tool: listDeals
 *
 * Lists deals matching filters: stage, personId, creation-date range. When
 * personId is given we hit `/persons/{id}/deals` (cheaper, returns all
 * statuses) and filter client-side; otherwise we hit `/deals` with stage_id.
 *
 * Default cap is 50 — the LLM can raise it but shouldn't routinely. For
 * deeper drill-in on one record, chain into `getDeal`.
 */

import type { DealStage, PipedriveDeal } from '@aac/api-clients/pipedrive';
import { toDealSummary, type DealSummary, type ToolDeps } from './types.js';

export interface ListDealsInput {
  stage?: DealStage;
  personId?: number;
  /** ISO date — created-at lower bound. Inclusive. */
  rangeStart?: string;
  /** ISO date — created-at upper bound. Inclusive. */
  rangeEnd?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

export async function listDeals(
  deps: ToolDeps,
  input: ListDealsInput,
): Promise<DealSummary[]> {
  let deals: PipedriveDeal[];

  if (input.personId !== undefined) {
    deals = await deps.pd.getDealsByPerson(input.personId);
    if (input.stage) {
      deals = deals.filter((d) => d.stage === input.stage);
    }
  } else {
    deals = await deps.pd.listDeals({
      ...(input.stage ? { stage: input.stage } : {}),
      limit: Math.max(input.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT),
    });
  }

  const startMs = input.rangeStart ? Date.parse(input.rangeStart) : null;
  const endMs = input.rangeEnd ? Date.parse(input.rangeEnd) : null;
  if (startMs !== null || endMs !== null) {
    deals = deals.filter((d) => {
      const t = Date.parse(d.addTime);
      if (Number.isNaN(t)) return false;
      if (startMs !== null && t < startMs) return false;
      if (endMs !== null && t > endMs) return false;
      return true;
    });
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  return deals.slice(0, limit).map(toDealSummary);
}
