import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { keys } from "@aac/shared-utils/redis";
import { loadTodos, todoScore, type TodoItem, type CreateTodoInput, type UpdateTodoInput } from "@/lib/todos";
import { requireApiSession } from "@/lib/api-auth";

/**
 * GET /api/todos — list all to-dos
 * Query params: status=pending|completed|all (default: all)
 */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  let items: TodoItem[];
  try {
    items = await loadTodos();
  } catch {
    return NextResponse.json([]);
  }
  const statusFilter = request.nextUrl.searchParams.get("status") ?? "all";
  if (statusFilter !== "all") {
    items = items.filter((item) => item.status === statusFilter);
  }
  return NextResponse.json(items);
}

/**
 * POST /api/todos — create a new to-do
 */
export async function POST(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
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
    ...(body.steps?.length ? { steps: body.steps } : {}),
  };

  const score = todoScore(item.dueDate);

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
  const denied = await requireApiSession(request);
  if (denied) return denied;
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
    steps: body.steps ?? existing.steps,
    completedAt:
      body.status === "completed" && existing.status !== "completed"
        ? new Date().toISOString()
        : body.status === "pending"
          ? null
          : existing.completedAt,
  };

  const score = todoScore(updated.dueDate);

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
  const denied = await requireApiSession(request);
  if (denied) return denied;
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
