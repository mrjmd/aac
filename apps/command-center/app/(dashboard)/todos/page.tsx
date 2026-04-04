"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Check, Trash2, RotateCcw } from "lucide-react";
import { cn } from "@aac/ui";
import type { TodoItem } from "@/lib/todos";

type Filter = "pending" | "completed" | "all";

export default function TodosPage() {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/todos?status=${filter}`)
      .then((r) => r.json())
      .then(setItems)
      .catch(() => {});
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setAdding(true);
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        dueDate: dueDate || null,
      }),
    });
    setTitle("");
    setDueDate("");
    setAdding(false);
    load();
  }

  async function toggleStatus(item: TodoItem) {
    const newStatus = item.status === "pending" ? "completed" : "pending";
    await fetch("/api/todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, status: newStatus }),
    });
    load();
  }

  async function deleteTodo(id: string) {
    await fetch("/api/todos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayMs = now.getTime();

  return (
    <div>
      <h2 className="font-display mb-6 text-2xl font-bold">Smart To-Do</h2>

      {/* Add form */}
      <form
        onSubmit={addTodo}
        className="mb-6 flex gap-3 rounded-xl border border-zinc-200 bg-white p-4"
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task..."
          className="flex-1 text-sm outline-none"
        />
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500"
        />
        <button
          type="submit"
          disabled={adding || !title.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-aac-blue px-4 py-1.5 text-sm font-bold text-white transition-colors hover:bg-aac-blue/90 disabled:opacity-50"
        >
          <Plus size={14} />
          Add
        </button>
      </form>

      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {(["pending", "completed", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              filter === f
                ? "bg-aac-dark text-white"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-2">
        {items.length === 0 && (
          <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center">
            <p className="text-sm text-zinc-400">
              {filter === "pending"
                ? "No pending tasks. Nice work!"
                : filter === "completed"
                  ? "No completed tasks yet."
                  : "No tasks yet. Add one above."}
            </p>
          </div>
        )}
        {items.map((item) => {
          const isOverdue =
            item.status === "pending" &&
            item.dueDate &&
            new Date(item.dueDate).getTime() < todayMs;

          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center gap-3 rounded-xl border bg-white px-4 py-3",
                isOverdue ? "border-red-200 bg-red-50" : "border-zinc-200",
              )}
            >
              {/* Complete/uncomplete button */}
              <button
                onClick={() => toggleStatus(item)}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  item.status === "completed"
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-zinc-300 hover:border-aac-blue",
                )}
              >
                {item.status === "completed" ? (
                  <Check size={12} />
                ) : item.status === "pending" ? null : (
                  <RotateCcw size={12} />
                )}
              </button>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-sm",
                    item.status === "completed"
                      ? "text-zinc-400 line-through"
                      : "text-aac-dark",
                  )}
                >
                  {item.title}
                </p>
                {item.notes && (
                  <p className="mt-0.5 text-xs text-zinc-400 line-clamp-1">
                    {item.notes}
                  </p>
                )}
              </div>

              {/* Due date */}
              {item.dueDate && (
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium",
                    isOverdue ? "text-red-600" : "text-zinc-400",
                  )}
                >
                  {new Date(item.dueDate).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}

              {/* Source badge */}
              {item.source !== "manual" && (
                <span className="shrink-0 rounded-full bg-aac-blue/10 px-2 py-0.5 text-[10px] font-medium text-aac-blue">
                  {item.source === "ai-detected" ? "AI" : "Recurring"}
                </span>
              )}

              {/* Delete */}
              <button
                onClick={() => deleteTodo(item.id)}
                className="shrink-0 text-zinc-300 transition-colors hover:text-red-500"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
