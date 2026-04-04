import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { contentIdeas } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId");
  const status = searchParams.get("status");

  const conditions = [];
  if (batchId) conditions.push(eq(contentIdeas.batchId, batchId));
  if (status) conditions.push(eq(contentIdeas.status, status));

  const ideas = await db
    .select()
    .from(contentIdeas)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(contentIdeas.createdAt))
    .limit(50);

  return NextResponse.json({ ideas });
}
