/**
 * To-do item types — defined in @aac/shared-utils so the tools/src/todos CLI
 * and triage.html share the exact shape this app reads and writes.
 */

import { keys } from "@aac/shared-utils/redis";
import { todoScore, type TodoItem } from "@aac/shared-utils/types";
import { getRedis } from "./redis";

export type {
  TodoItem,
  TodoStep,
  CreateTodoInput,
  UpdateTodoInput,
} from "@aac/shared-utils/types";
export { todoScore } from "@aac/shared-utils/types";

/** Every to-do, ordered by due date (undated last). */
export async function loadTodos(): Promise<TodoItem[]> {
  const redis = getRedis();
  const ids = await redis.zrange<string[]>(keys.todoList, 0, -1);
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(keys.todo(id));
  const results = await pipeline.exec<(TodoItem | null)[]>();
  return results.filter((item): item is TodoItem => item !== null);
}

/** Mark a to-do completed (from Done on Today). No-op if it's gone or already done. */
export async function completeTodo(id: string): Promise<void> {
  const redis = getRedis();
  const existing = await redis.get<TodoItem>(keys.todo(id));
  if (!existing || existing.status === "completed") return;
  const updated: TodoItem = { ...existing, status: "completed", completedAt: new Date().toISOString() };
  await Promise.all([
    redis.set(keys.todo(id), updated),
    redis.zadd(keys.todoList, { score: todoScore(updated.dueDate), member: id }),
  ]);
}
