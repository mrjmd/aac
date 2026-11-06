import { NextRequest, NextResponse } from "next/server";
import type { MuteRule } from "@aac/items";
import { getItemStore } from "@/lib/items";
import { requireApiSession } from "@/lib/api-auth";

/** GET /api/items/mutes — active mute rules. */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return NextResponse.json(await getItemStore().getMutes());
}

/**
 * POST /api/items/mutes  { detector, match?, note?, confirmed? }
 * Muting a money/legal detector (D1-D3) needs confirmed: true (409 otherwise).
 */
export async function POST(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const body = (await request.json()) as { detector?: string; match?: string; note?: string; confirmed?: boolean };
  if (!body.detector) return NextResponse.json({ error: "detector required" }, { status: 400 });
  const store = getItemStore();
  const snapshot = await store.getCandidates();
  const sensitive = snapshot?.candidates.find(
    (c) => c.detector.toLowerCase() === body.detector!.toLowerCase() && c.sensitive,
  )?.sensitive;
  if (sensitive && !body.confirmed) return NextResponse.json({ confirm: sensitive }, { status: 409 });
  const rule: MuteRule = {
    id: crypto.randomUUID(),
    detector: body.detector,
    createdAt: new Date().toISOString(),
    ...(body.match ? { match: body.match } : {}),
    ...(body.note ? { note: body.note } : {}),
  };
  await store.putMute(rule);
  return NextResponse.json({ ok: true, rule });
}

/** DELETE /api/items/mutes?id=... — un-mute. */
export async function DELETE(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await getItemStore().deleteMute(id);
  return NextResponse.json({ ok: true });
}
