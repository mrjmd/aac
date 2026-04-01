"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DashboardCard } from "@aac/ui";
import type { MiddlewareHealth } from "@/lib/middleware-health";
import { deriveMiddlewareStatus } from "@/lib/middleware-status";

function totalEvents(data: MiddlewareHealth): number {
  if (!data.metrics) return 0;
  const w = data.metrics.webhooks;
  return (
    w.pipedrive.processed24h + w.quo.processed24h + w.googleAds.processed24h
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function MiddlewareHealthCard() {
  const [data, setData] = useState<MiddlewareHealth | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/health/middleware");
        if (active && res.ok) setData(await res.json());
      } catch {
        /* silent — card shows gray */
      }
    }

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const { level, label } = deriveMiddlewareStatus(data);

  return (
    <Link href="/health">
      <DashboardCard
        title="Middleware Health"
        status={level}
        statusLabel={label}
        className="cursor-pointer transition-all hover:border-aac-blue hover:shadow-md"
      >
        {data?.metrics ? (
          <div className="space-y-2">
            <p className="text-2xl font-bold text-aac-dark">
              {totalEvents(data)}{" "}
              <span className="text-sm font-medium text-zinc-400">
                events today
              </span>
            </p>
            <p className="text-xs text-zinc-400">
              Last event:{" "}
              {timeAgo(
                [
                  data.metrics.webhooks.pipedrive.lastProcessed,
                  data.metrics.webhooks.quo.lastProcessed,
                  data.metrics.webhooks.googleAds.lastProcessed,
                ]
                  .filter(Boolean)
                  .sort()
                  .pop() ?? null,
              )}
            </p>
          </div>
        ) : data?.error ? (
          <p className="text-sm text-red-500">{data.error}</p>
        ) : (
          <p className="text-sm text-zinc-400">Loading...</p>
        )}
      </DashboardCard>
    </Link>
  );
}
