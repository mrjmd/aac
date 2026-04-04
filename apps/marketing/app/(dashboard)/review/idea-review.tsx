"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RotateCcw, X, Sparkles } from "lucide-react";
import type { contentIdeas } from "@/db/schema";

type Idea = typeof contentIdeas.$inferSelect;

interface IdeaMeta {
  text: string;
  suggestedPlatforms: string[];
  suggestedTemplate: string;
  visualApproach: string;
  sourceType?: string;
}

function parseMeta(description: string | null): IdeaMeta {
  if (!description) return { text: "", suggestedPlatforms: [], suggestedTemplate: "", visualApproach: "" };
  try {
    return JSON.parse(description) as IdeaMeta;
  } catch {
    return { text: description, suggestedPlatforms: [], suggestedTemplate: "", visualApproach: "" };
  }
}

const REJECTION_REASONS = [
  { value: "off-brand", label: "Off-brand" },
  { value: "wrong-tone", label: "Wrong tone" },
  { value: "duplicate", label: "Duplicate" },
  { value: "irrelevant", label: "Irrelevant" },
  { value: "other", label: "Other" },
];

const PILLAR_COLORS: Record<string, string> = {
  educational: "bg-blue-100 text-blue-700",
  showcase: "bg-purple-100 text-purple-700",
  seasonal: "bg-amber-100 text-amber-700",
  testimonial: "bg-emerald-100 text-emerald-700",
  personality: "bg-pink-100 text-pink-700",
  blog: "bg-indigo-100 text-indigo-700",
};

export function IdeaReview({ idea }: { idea: Idea }) {
  const router = useRouter();
  const meta = parseMeta(idea.description);
  const [mode, setMode] = useState<"view" | "revise" | "reject">("view");
  const [feedback, setFeedback] = useState("");
  const [reason, setReason] = useState("off-brand");
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  async function handleAction(action: "approve" | "revise" | "reject") {
    setLoading(true);
    try {
      const res = await fetch(`/api/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "revise" ? { feedback } : {}),
          ...(action === "reject" ? { rejectionReason: reason } : {}),
        }),
      });
      const data = await res.json();

      // Auto-backfill: if reject returned backfill info, generate replacements
      if (action === "reject" && data.backfill) {
        setBackfilling(true);
        setMode("view");
        await fetch("/api/ideas/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batchId: data.backfill.batchId,
            count: data.backfill.count,
            excludeTopics: data.backfill.rejectedTopics,
          }),
        });
        setBackfilling(false);
      }

      setMode("view");
      setFeedback("");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const isTerminal = idea.status === "approved" || idea.status === "rejected";

  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-sm font-bold text-aac-dark">{idea.title}</h3>
        {idea.version && idea.version > 1 && (
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
            v{idea.version}
          </span>
        )}
      </div>

      {/* Meta badges */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {idea.pillar && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${PILLAR_COLORS[idea.pillar] ?? "bg-zinc-100 text-zinc-600"}`}
          >
            {idea.pillar}
          </span>
        )}
        {meta.suggestedTemplate && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
            Template {meta.suggestedTemplate}
          </span>
        )}
        {meta.sourceType && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              meta.sourceType === "ai-full"
                ? "bg-violet-100 text-violet-700"
                : "bg-orange-100 text-orange-700"
            }`}
          >
            {meta.sourceType === "ai-full" ? "AI Generated" : "Real Photo"}
          </span>
        )}
        {meta.suggestedPlatforms.map((p) => (
          <span
            key={p}
            className="rounded-full bg-zinc-50 px-2 py-0.5 text-[10px] text-zinc-400"
          >
            {p}
          </span>
        ))}
      </div>

      {/* Description */}
      <p className="mb-2 flex-1 text-sm text-zinc-600">{meta.text}</p>

      {meta.visualApproach && (
        <p className="mb-4 flex items-start gap-1.5 text-xs text-zinc-400">
          <Sparkles size={12} className="mt-0.5 shrink-0" />
          {meta.visualApproach}
        </p>
      )}

      {/* Revision feedback shown if revising */}
      {idea.revisionFeedback && idea.status === "draft" && idea.version && idea.version > 1 && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Revised from: &ldquo;{idea.revisionFeedback}&rdquo;
        </div>
      )}

      {/* Status badge for terminal states */}
      {idea.status === "approved" && (
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
          <Check size={12} /> Approved
        </div>
      )}
      {idea.status === "rejected" && (
        <div className="mb-2 text-xs text-zinc-400">
          Rejected: {idea.rejectionReason ?? "no reason"}
        </div>
      )}

      {backfilling && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-aac-blue/5 px-3 py-2 text-xs font-medium text-aac-blue">
          <Sparkles size={12} className="animate-pulse" />
          Generating replacement ideas…
        </div>
      )}

      {/* Action buttons */}
      {!isTerminal && mode === "view" && (
        <div className="mt-auto flex gap-2 border-t border-zinc-100 pt-3">
          <button
            onClick={() => handleAction("approve")}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            <Check size={12} /> Approve
          </button>
          <button
            onClick={() => setMode("revise")}
            className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-200"
          >
            <RotateCcw size={12} /> Revise
          </button>
          <button
            onClick={() => setMode("reject")}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-500 transition-colors hover:bg-zinc-200"
          >
            <X size={12} /> Reject
          </button>
        </div>
      )}

      {/* Revise mode */}
      {mode === "revise" && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change? e.g., 'Make it more seasonal' or 'Focus on coastal homes'"
            rows={2}
            autoFocus
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none transition-colors focus:border-aac-blue"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("revise")}
              disabled={loading || !feedback.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
            >
              <RotateCcw size={12} /> {loading ? "Revising…" : "Submit Revision"}
            </button>
            <button
              onClick={() => { setMode("view"); setFeedback(""); }}
              className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Reject mode */}
      {mode === "reject" && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
          >
            {REJECTION_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("reject")}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              <X size={12} /> {loading ? "Rejecting…" : "Confirm Reject"}
            </button>
            <button
              onClick={() => setMode("view")}
              className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
