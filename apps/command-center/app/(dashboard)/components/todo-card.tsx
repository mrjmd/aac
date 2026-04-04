"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DashboardCard, type StatusLevel } from "@aac/ui";
import type { TodoItem } from "@/lib/todos";

function deriveStatus(items: TodoItem[]): {
  level: StatusLevel;
  label: string;
} {
  if (!items.length) return { level: "green", label: "All clear" };

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayMs = now.getTime();

  const overdue = items.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < todayMs,
  );
  const dueSoon = items.filter((t) => {
    if (!t.dueDate) return false;
    const due = new Date(t.dueDate).getTime();
    return due >= todayMs && due <= todayMs + 2 * 86_400_000;
  });

  if (overdue.length > 0)
    return {
      level: "red",
      label: `${overdue.length} overdue`,
    };
  if (dueSoon.length > 0)
    return {
      level: "yellow",
      label: `${dueSoon.length} due soon`,
    };
  return { level: "green", label: `${items.length} pending` };
}

export function TodoCard() {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/todos?status=pending")
      .then((r) => r.json())
      .then((data: TodoItem[]) => {
        setItems(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const { level, label } = loaded
    ? deriveStatus(items)
    : { level: "gray" as StatusLevel, label: "Loading" };

  const next3 = items.slice(0, 3);

  return (
    <Link href="/todos">
      <DashboardCard
        title="Smart To-Do"
        status={level}
        statusLabel={label}
        className="cursor-pointer transition-all hover:border-aac-blue hover:shadow-md"
      >
        {loaded ? (
          items.length > 0 ? (
            <div className="space-y-1.5">
              {next3.map((item) => (
                <div key={item.id} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-zinc-300" />
                  <span className="text-aac-dark line-clamp-1">
                    {item.title}
                  </span>
                  {item.dueDate && (
                    <span className="ml-auto shrink-0 text-xs text-zinc-400">
                      {new Date(item.dueDate).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                </div>
              ))}
              {items.length > 3 && (
                <p className="text-xs text-zinc-400">
                  +{items.length - 3} more
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No pending tasks.</p>
          )
        ) : (
          <p className="text-sm text-zinc-400">Loading...</p>
        )}
      </DashboardCard>
    </Link>
  );
}
