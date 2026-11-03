"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@aac/ui";

function ago(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * "Updated 12 min ago ↻" for one saved card. The button re-reads that
 * card's source (and only that one), then re-renders the page.
 */
export function Freshness({
  name,
  fetchedAt,
  label,
  className,
}: {
  name: string;
  fetchedAt?: string | null;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/snapshots/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-zinc-400", className)}>
      {label && <span className="font-medium text-zinc-500">{label}</span>}
      <span title={fetchedAt ? new Date(fetchedAt).toLocaleString() : undefined}>
        {busy ? "refreshing…" : fetchedAt ? `updated ${ago(fetchedAt, now)}` : "not loaded"}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        aria-label={`Refresh ${label ?? name}`}
        className="rounded p-1 hover:bg-zinc-100 hover:text-aac-blue disabled:opacity-50"
      >
        <RotateCw size={12} className={cn(busy && "animate-spin")} />
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}
