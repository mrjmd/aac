"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  RotateCcw,
  X,
  Sparkles,
  Image as ImageIcon,
} from "lucide-react";
import type { contentIdeas, platformVariants } from "@/db/schema";

type Idea = typeof contentIdeas.$inferSelect;
type Variant = typeof platformVariants.$inferSelect;

interface IdeaMeta {
  text: string;
  suggestedPlatforms: string[];
  suggestedTemplate: string;
  visualApproach: string;
  sourceType?: string;
}

function parseMeta(description: string | null): IdeaMeta {
  if (!description)
    return { text: "", suggestedPlatforms: [], suggestedTemplate: "", visualApproach: "" };
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

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "IG",
  facebook: "FB",
  linkedin: "LI",
  gbp: "GBP",
};

export function IdeaReview({
  idea,
  variants,
}: {
  idea: Idea;
  variants?: Variant[];
}) {
  const router = useRouter();
  const meta = parseMeta(idea.description);
  const [mode, setMode] = useState<"view" | "revise" | "reject">("view");
  const [feedback, setFeedback] = useState("");
  const [reason, setReason] = useState("off-brand");
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [generatingPost, setGeneratingPost] = useState(false);

  const hasVariants = variants && variants.length > 0;
  const isTerminal = idea.status === "rejected";
  const isDraft = idea.status === "draft" || idea.status === "revising";

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

      // Auto-backfill on reject
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

      // Auto-generate post on approve
      if (action === "approve") {
        setGeneratingPost(true);
        setMode("view");
        router.refresh();
        await fetch("/api/posts/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId: idea.id }),
        });
        setGeneratingPost(false);
      }

      setMode("view");
      setFeedback("");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

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
      </div>

      {/* Description */}
      <p className="mb-2 text-sm text-zinc-600">{meta.text}</p>

      {!hasVariants && meta.visualApproach && (
        <p className="mb-4 flex items-start gap-1.5 text-xs text-zinc-400">
          <Sparkles size={12} className="mt-0.5 shrink-0" />
          {meta.visualApproach}
        </p>
      )}

      {/* Revision feedback */}
      {idea.revisionFeedback && idea.status === "draft" && idea.version && idea.version > 1 && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Revised from: &ldquo;{idea.revisionFeedback}&rdquo;
        </div>
      )}

      {/* Status indicators */}
      {idea.status === "approved" && !idea.postId && !generatingPost && (
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-600">
          <Check size={12} /> Concept approved
        </div>
      )}

      {generatingPost && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-aac-blue/5 px-3 py-2 text-xs font-medium text-aac-blue">
          <Sparkles size={12} className="animate-pulse" />
          Generating image + captions…
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

      {/* ── TIER 2: Inline Visual Review ─────────────────────────── */}
      {hasVariants && <InlineVariantReview variants={variants} />}

      {/* ── TIER 1: Idea Actions ─────────────────────────────────── */}
      {isDraft && !isTerminal && mode === "view" && (
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

      {mode === "revise" && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change?"
            rows={2}
            autoFocus
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none transition-colors focus:border-aac-blue"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("revise")}
              disabled={loading || !feedback.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
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

      {mode === "reject" && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
          >
            {REJECTION_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => handleAction("reject")}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
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

// ── Inline Variant Review (Tier 2) ─────────────────────────────────

function InlineVariantReview({ variants }: { variants: Variant[] }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(variants[0]?.platform ?? "");
  const active = variants.find((v) => v.platform === activeTab);
  const [loading, setLoading] = useState("");
  const [reviseTarget, setReviseTarget] = useState<"" | "caption" | "image">("");
  const [reviseText, setReviseText] = useState("");

  async function handleVariantAction(
    variantId: number,
    target: "caption" | "image",
    action: "approve" | "revise" | "reject",
    feedback?: string,
  ) {
    setLoading(`${target}-${action}`);
    try {
      await fetch(`/api/posts/variants/${variantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action, feedback }),
      });
      setReviseTarget("");
      setReviseText("");
      router.refresh();
    } finally {
      setLoading("");
    }
  }

  if (!active) return null;

  return (
    <div className="mt-4 border-t border-zinc-100 pt-4">
      {/* Platform tabs */}
      <div className="mb-3 flex gap-1">
        {variants.map((v) => (
          <button
            key={v.platform}
            onClick={() => { setActiveTab(v.platform); setReviseTarget(""); }}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              activeTab === v.platform
                ? "bg-aac-blue text-white"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
            }`}
          >
            {PLATFORM_LABELS[v.platform] ?? v.platform}
            {v.captionStatus === "approved" && v.imageStatus === "approved" && (
              <Check size={10} className="ml-1 inline" />
            )}
          </button>
        ))}
      </div>

      {/* Image */}
      <div className="mb-3">
        {active.imageUrl ? (
          <div className="overflow-hidden rounded-lg border border-zinc-100">
            <img src={active.imageUrl} alt="" className="w-full" />
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 bg-zinc-50">
            <div className="text-center text-zinc-400">
              <ImageIcon size={24} className="mx-auto mb-1" />
              <p className="text-xs">No image yet</p>
            </div>
          </div>
        )}

        {/* Image actions */}
        {active.imageStatus !== "approved" && reviseTarget !== "image" && (
          <div className="mt-2 flex gap-1.5">
            {active.imageUrl && (
              <button
                onClick={() => handleVariantAction(active.id, "image", "approve")}
                disabled={!!loading}
                className="flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                <Check size={10} /> Approve
              </button>
            )}
            <button
              onClick={() => setReviseTarget("image")}
              className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-200"
            >
              <RotateCcw size={10} /> Regenerate
            </button>
          </div>
        )}
        {active.imageStatus === "approved" && (
          <p className="mt-2 flex items-center gap-1 text-[10px] font-medium text-emerald-600">
            <Check size={10} /> Image approved
          </p>
        )}
        {reviseTarget === "image" && (
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              placeholder='e.g., "warmer", "more dramatic"'
              autoFocus
              className="flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-aac-blue"
            />
            <button
              onClick={() => handleVariantAction(active.id, "image", "revise", reviseText)}
              disabled={!!loading}
              className="rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {loading === "image-revise" ? "…" : "Go"}
            </button>
            <button
              onClick={() => { setReviseTarget(""); setReviseText(""); }}
              className="text-[10px] text-zinc-400"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Caption */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Caption
          </span>
          {active.captionStatus === "approved" && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
              <Check size={10} /> Approved
            </span>
          )}
        </div>
        <div className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
          {active.caption || "No caption generated."}
        </div>

        {active.captionStatus !== "approved" && reviseTarget !== "caption" && (
          <div className="flex gap-1.5">
            {active.caption && (
              <button
                onClick={() => handleVariantAction(active.id, "caption", "approve")}
                disabled={!!loading}
                className="flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                <Check size={10} /> Approve
              </button>
            )}
            <button
              onClick={() => setReviseTarget("caption")}
              className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-200"
            >
              <RotateCcw size={10} /> Revise
            </button>
          </div>
        )}
        {reviseTarget === "caption" && (
          <div className="mt-1 flex gap-1.5">
            <input
              type="text"
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              placeholder='e.g., "shorter", "add emoji"'
              autoFocus
              className="flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-aac-blue"
            />
            <button
              onClick={() => handleVariantAction(active.id, "caption", "revise", reviseText)}
              disabled={!!loading}
              className="rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {loading === "caption-revise" ? "…" : "Go"}
            </button>
            <button
              onClick={() => { setReviseTarget(""); setReviseText(""); }}
              className="text-[10px] text-zinc-400"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
