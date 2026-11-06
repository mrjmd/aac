import { NextResponse } from "next/server";
import { hasBearerSecret } from "@aac/shared-utils/request-secret";
import { cards, refreshCard } from "@/lib/cards";

export const maxDuration = 300;

/**
 * GET — Vercel cron (every 15 min, vercel.json): re-read the shared cards
 * (cash, Mike's weeks, customer list, calendar index, invoice nudges, CI) so
 * pages open on current data. Customer-specific parts refresh when viewed. Bearer
 * CRON_SECRET; the session middleware lets this one path through.
 */
export async function GET(req: Request) {
  if (!hasBearerSecret(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shared = [cards.cash(), cards.techWeeks(), cards.customerIndex(), cards.calendarIndex(), cards.nudges(), cards.ci()];
  const results = await Promise.allSettled(shared.map((c) => refreshCard(c.name)));
  return NextResponse.json(
    Object.fromEntries(
      shared.map((c, i) => {
        const r = results[i];
        return [c.name, r.status === "fulfilled" ? r.value?.fetchedAt : `error: ${(r.reason as Error).message}`];
      }),
    ),
  );
}
