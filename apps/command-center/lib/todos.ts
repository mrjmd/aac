/**
 * To-do item types and Redis operations.
 */

export interface TodoItem {
  id: string;
  title: string;
  dueDate: string | null; // ISO date string (date only, e.g. "2026-04-05")
  notes: string;
  status: "pending" | "completed";
  source: "manual" | "ai-detected" | "recurring";
  createdAt: string; // ISO timestamp
  completedAt: string | null; // ISO timestamp
}

export type CreateTodoInput = Pick<TodoItem, "title"> &
  Partial<Pick<TodoItem, "dueDate" | "notes" | "source">>;

export type UpdateTodoInput = Partial<
  Pick<TodoItem, "title" | "dueDate" | "notes" | "status">
>;
