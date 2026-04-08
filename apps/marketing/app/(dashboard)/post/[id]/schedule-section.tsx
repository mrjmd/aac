"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Check, AlertCircle, X, RotateCcw } from "lucide-react";
import type { contentPosts, platformVariants } from "@/db/schema";

type Post = typeof contentPosts.$inferSelect;
type Variant = typeof platformVariants.$inferSelect;

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  gbp: "Google Business Profile",
};

interface VariantResult {
  variantId: number;
  platform: string;
  ok: boolean;
  bufferPostId?: string;
  error?: string;
}

export function ScheduleSection({
  post,
  variants,
  nextSlotIso,
}: {
  post: Post;
  variants: Variant[];
  nextSlotIso: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<"" | "auto" | "manual" | "retry" | "unschedule">("");
  const [showManual, setShowManual] = useState(false);
  const [manualDate, setManualDate] = useState(() => defaultDatetimeLocal(nextSlotIso));
  const [results, setResults] = useState<VariantResult[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function callSchedule(body: object, action: typeof loading) {
    setLoading(action);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/posts/${post.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "Schedule failed");
        return;
      }
      setResults(data.results);
      router.refresh();
    } finally {
      setLoading("");
    }
  }

  async function callUnschedule() {
    setLoading("unschedule");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/posts/${post.id}/unschedule`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "Unschedule failed");
        return;
      }
      setResults(null);
      router.refresh();
    } finally {
      setLoading("");
    }
  }

  // ── Render: scheduled state ─────────────────────────────────────
  if (post.status === "scheduled") {
    const failedVariants = variants.filter((v) => v.publishStatus === "failed");

    return (
      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-base font-bold text-aac-dark">
            Scheduled
          </h3>
          <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
            {formatDateInTz(post.scheduledAt)}
          </span>
        </div>

        <div className="mb-4 space-y-1.5">
          {variants.map((v) => (
            <VariantStatusRow
              key={v.id}
              variant={v}
              loading={loading === "retry"}
              onRetry={
                v.publishStatus === "failed"
                  ? () => callSchedule({ mode: "retry" }, "retry")
                  : undefined
              }
            />
          ))}
        </div>

        {errorMsg && <ErrorBanner message={errorMsg} />}

        <div className="flex gap-2">
          {failedVariants.length > 0 && (
            <button
              onClick={() => callSchedule({ mode: "retry" }, "retry")}
              disabled={!!loading}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              <RotateCcw size={12} />
              {loading === "retry" ? "Retrying…" : `Retry ${failedVariants.length} failed`}
            </button>
          )}
          <button
            onClick={callUnschedule}
            disabled={!!loading}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-600 hover:bg-zinc-200 disabled:opacity-50"
          >
            <X size={12} />
            {loading === "unschedule" ? "Unscheduling…" : "Unschedule"}
          </button>
        </div>
      </section>
    );
  }

  // ── Render: review state, ready to schedule ───────────────────
  if (post.status !== "review") return null;

  return (
    <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="mb-1 font-display text-base font-bold text-aac-dark">
        Schedule
      </h3>
      <p className="mb-4 text-xs text-zinc-400">
        All variants approved. Auto-schedule slots into the next open Mon/Wed/Fri 10am ET.
      </p>

      {results && results.some((r) => !r.ok) && (
        <div className="mb-4 space-y-1.5">
          {results.filter((r) => !r.ok).map((r) => (
            <div
              key={r.variantId}
              className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">{PLATFORM_LABELS[r.platform] ?? r.platform}</div>
                <div className="text-red-600">{r.error}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {errorMsg && <ErrorBanner message={errorMsg} />}

      {/* Auto-schedule primary CTA */}
      {nextSlotIso ? (
        <button
          onClick={() => callSchedule({ mode: "auto" }, "auto")}
          disabled={!!loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-aac-blue px-4 py-3 text-sm font-bold text-white hover:bg-aac-blue/90 disabled:opacity-50"
        >
          <Calendar size={16} />
          {loading === "auto"
            ? "Scheduling…"
            : `Auto-schedule for ${formatDateInTz(nextSlotIso)}`}
        </button>
      ) : (
        <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          Could not compute next slot — use manual scheduling below.
        </div>
      )}

      {/* Manual fallback */}
      <div className="mt-3">
        {!showManual ? (
          <button
            onClick={() => setShowManual(true)}
            className="text-xs text-zinc-400 underline hover:text-zinc-600"
          >
            Schedule for a specific date instead…
          </button>
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <label className="mb-2 block text-xs font-semibold text-zinc-500">
              Specific date and time
            </label>
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-aac-blue"
              />
              <button
                onClick={() =>
                  callSchedule(
                    { mode: "manual", scheduledAt: new Date(manualDate).toISOString() },
                    "manual",
                  )
                }
                disabled={!!loading || !manualDate}
                className="rounded-lg bg-aac-blue px-3 py-2 text-xs font-bold text-white hover:bg-aac-blue/90 disabled:opacity-50"
              >
                {loading === "manual" ? "…" : "Schedule"}
              </button>
              <button
                onClick={() => setShowManual(false)}
                className="rounded-lg px-2 py-2 text-xs text-zinc-400 hover:text-zinc-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Subcomponents ────────────────────────────────────────────────

function VariantStatusRow({
  variant,
  loading,
  onRetry,
}: {
  variant: Variant;
  loading: boolean;
  onRetry?: () => void;
}) {
  const status = variant.publishStatus;
  return (
    <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {status === "scheduled" && (
          <Check size={12} className="text-emerald-500" />
        )}
        {status === "failed" && (
          <AlertCircle size={12} className="text-red-500" />
        )}
        <span className="font-medium text-zinc-700">
          {PLATFORM_LABELS[variant.platform] ?? variant.platform}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            status === "scheduled"
              ? "bg-emerald-100 text-emerald-700"
              : status === "failed"
                ? "bg-red-100 text-red-700"
                : "bg-zinc-200 text-zinc-600"
          }`}
        >
          {status}
        </span>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={loading}
          className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 disabled:opacity-50"
        >
          retry
        </button>
      )}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDateInTz(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Build the default value for a datetime-local input from an ISO string. */
function defaultDatetimeLocal(iso: string | null): string {
  const date = iso ? new Date(iso) : nextWeekday9am();
  // datetime-local expects YYYY-MM-DDTHH:mm in local time (browser's timezone)
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nextWeekday9am(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}
