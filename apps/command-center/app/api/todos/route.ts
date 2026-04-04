import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { keys } from "@aac/shared-utils/redis";
import type { TodoItem, CreateTodoInput, UpdateTodoInput } from "@/lib/todos";

/**
 * GET /api/todos — list all to-dos
 * Query params: status=pending|completed|all (default: all)
 */
export async function GET(request: NextRequest) {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return NextResponse.json([]);
  }
  const statusFilter = request.nextUrl.searchParams.get("status") ?? "all";

  // Get all to-do IDs from the sorted set (ordered by due date)
  const ids = await redis.zrange<string[]>(keys.todoList, 0, -1);

  if (!ids.length) {
    return NextResponse.json([]);
  }

  // Fetch all items in parallel
  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.get(keys.todo(id));
  }
  const results = await pipeline.exec<(TodoItem | null)[]>();

  let items = results.filter((item): item is TodoItem => item !== null);

  if (statusFilter !== "all") {
    items = items.filter((item) => item.status === statusFilter);
  }

  return NextResponse.json(items);
}

/**
 * POST /api/todos — create a new to-do
 */
export async function POST(request: NextRequest) {
  const redis = getRedis();
  const body = (await request.json()) as CreateTodoInput;

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item: TodoItem = {
    id,
    title: body.title.trim(),
    dueDate: body.dueDate ?? null,
    notes: body.notes?.trim() ?? "",
    status: "pending",
    source: body.source ?? "manual",
    createdAt: now,
    completedAt: null,
  };

  // Score for sorted set: due date epoch ms, or far future if no due date
  const score = item.dueDate
    ? new Date(item.dueDate).getTime()
    : 9999999999999;

  await Promise.all([
    redis.set(keys.todo(id), item),
    redis.zadd(keys.todoList, { score, member: id }),
  ]);

  return NextResponse.json(item, { status: 201 });
}

/**
 * PATCH /api/todos — update a to-do
 * Body: { id, ...updates }
 */
export async function PATCH(request: NextRequest) {
  const redis = getRedis();
  const body = (await request.json()) as UpdateTodoInput & { id: string };

  if (!body.id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const existing = await redis.get<TodoItem>(keys.todo(body.id));
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated: TodoItem = {
    ...existing,
    title: body.title?.trim() ?? existing.title,
    dueDate: body.dueDate !== undefined ? body.dueDate : existing.dueDate,
    notes: body.notes !== undefined ? body.notes.trim() : existing.notes,
    status: body.status ?? existing.status,
    completedAt:
      body.status === "completed" && existing.status !== "completed"
        ? new Date().toISOString()
        : body.status === "pending"
          ? null
          : existing.completedAt,
  };

  // Update score if due date changed
  const score = updated.dueDate
    ? new Date(updated.dueDate).getTime()
    : 9999999999999;

  await Promise.all([
    redis.set(keys.todo(body.id), updated),
    redis.zadd(keys.todoList, { score, member: body.id }),
  ]);

  return NextResponse.json(updated);
}

/**
 * DELETE /api/todos — delete a to-do
 * Body: { id }
 */
export async function DELETE(request: NextRequest) {
  const redis = getRedis();
  const body = (await request.json()) as { id: string };

  if (!body.id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  await Promise.all([
    redis.del(keys.todo(body.id)),
    redis.zrem(keys.todoList, body.id),
  ]);

  return NextResponse.json({ ok: true });
}
