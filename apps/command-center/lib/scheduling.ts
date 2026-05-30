/**
 * Read pending SchedulingDirectives from Redis.
 *
 * The middleware webhook handlers write directives via
 * `writePendingDirective`. Confidence ≥ 0.7 → blob stored at
 * `scheduling:pending:{id}`, id pushed onto `scheduling:pending:list`
 * (the auto-propose queue, newest first). Below 0.7 → blob at the same key
 * but id goes on `scheduling:pending-review:list` (the manual-triage queue).
 * Both are capped at 500.
 *
 * This is the read side for the command-center scheduling view.
 */

import { getRedis } from "./redis";
import { keys } from "@aac/shared-utils/redis";
import type { SchedulingDirective } from "@aac/scheduling";

/**
 * Decision recorded by middleware after the agent receives Matt's reply
 * to a proposal. Mirrors `RecordedProposalDecision` in apps/middleware/
 * lib/redis.ts (kept independently typed here to avoid an app→app
 * import; the two declarations must stay in sync — both should move
 * into `@aac/scheduling/proposal.ts` if this drifts).
 */
export interface DirectiveProposalDecision {
  proposalId: string;
  directiveId: string;
  decision: "approved" | "rejected" | "edit";
  replyText: string;
  decidedAt: string;
  recordedAt: string;
}

export interface PendingDirectiveWithDecision {
  directive: SchedulingDirective;
  decision: DirectiveProposalDecision | null;
}

export interface PendingDirectivesResult {
  directives: SchedulingDirective[];
  decisionsByDirectiveId: Record<string, DirectiveProposalDecision>;
  totalIds: number;
  fetched: number;
  staleIds: string[];
}

export interface PendingDirectivesByQueue {
  autoPropose: PendingDirectivesResult;
  needsReview: PendingDirectivesResult;
}

/**
 * Read up to `limit` most-recent directives from the auto-propose queue
 * AND the needs-review queue, fanned out in parallel.
 */
export async function fetchPendingDirectives(
  limit = 100,
): Promise<PendingDirectivesByQueue> {
  const [autoPropose, needsReview] = await Promise.all([
    readQueue(keys.schedulingPendingList, limit),
    readQueue(keys.schedulingPendingReviewList, limit),
  ]);
  return { autoPropose, needsReview };
}

async function readQueue(
  listKey: string,
  limit: number,
): Promise<PendingDirectivesResult> {
  const redis = getRedis();
  const ids = await redis.lrange<string>(listKey, 0, limit - 1);

  if (ids.length === 0) {
    return {
      directives: [],
      decisionsByDirectiveId: {},
      totalIds: 0,
      fetched: 0,
      staleIds: [],
    };
  }

  const stage1 = redis.pipeline();
  for (const id of ids) stage1.get(keys.schedulingPending(id));
  for (const id of ids) stage1.get(keys.schedulingProposalByDirective(id));
  const stage1Results = await stage1.exec<unknown[]>();

  const directiveResults = stage1Results.slice(0, ids.length) as Array<
    SchedulingDirective | null
  >;
  const proposalIdResults = stage1Results.slice(ids.length) as Array<string | null>;

  const directives: SchedulingDirective[] = [];
  const staleIds: string[] = [];
  directiveResults.forEach((d, i) => {
    if (d) directives.push(d);
    else staleIds.push(ids[i]);
  });

  const decisionTargets: Array<{ directiveId: string; proposalId: string }> = [];
  proposalIdResults.forEach((pid, i) => {
    if (pid) decisionTargets.push({ directiveId: ids[i], proposalId: pid });
  });

  const decisionsByDirectiveId: Record<string, DirectiveProposalDecision> = {};
  if (decisionTargets.length > 0) {
    const stage2 = redis.pipeline();
    for (const t of decisionTargets) {
      stage2.get(keys.schedulingProposalDecision(t.proposalId));
    }
    const decisionResults = await stage2.exec<(DirectiveProposalDecision | null)[]>();
    decisionResults.forEach((d, i) => {
      if (d) decisionsByDirectiveId[decisionTargets[i].directiveId] = d;
    });
  }

  return {
    directives,
    decisionsByDirectiveId,
    totalIds: ids.length,
    fetched: directives.length,
    staleIds,
  };
}
