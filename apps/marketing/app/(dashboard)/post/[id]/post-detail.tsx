"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  RotateCcw,
  X,
  Sparkles,
  Image as ImageIcon,
  ArrowLeft,
} from "lucide-react";
import type { contentPosts, platformVariants } from "@/db/schema";
import { ScheduleSection } from "./schedule-section";

type Post = typeof contentPosts.$inferSelect;
type Variant = typeof platformVariants.$inferSelect;

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  gbp: "Google Business Profile",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-500",
  generated: "bg-blue-100 text-blue-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

export function PostDetail({
  post,
  variants,
  nextSlotIso,
}: {
  post: Post;
  variants: Variant[];
  nextSlotIso: string | null;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(variants[0]?.platform ?? "instagram");
  const activeVariant = variants.find((v) => v.platform === activeTab);

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <button
        onClick={() => router.push("/review")}
        className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-600"
      >
        <ArrowLeft size={14} /> Back to Review
      </button>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-aac-dark">
            {post.concept}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
              {post.type}
            </span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
              Template {post.templateId ?? "—"}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                post.sourceType === "ai-full"
                  ? "bg-violet-100 text-violet-700"
                  : "bg-orange-100 text-orange-700"
              }`}
            >
              {post.sourceType === "ai-full" ? "AI Generated" : "Real Photo"}
            </span>
            <PostStatusBadge status={post.status} />
          </div>
        </div>
      </div>

      {/* Platform Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1">
        {variants.map((v) => (
          <button
            key={v.platform}
            onClick={() => setActiveTab(v.platform)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === v.platform
                ? "bg-white text-aac-dark shadow-sm"
                : "text-zinc-500 hover:text-zinc-700"
            }`}
          >
            {PLATFORM_LABELS[v.platform] ?? v.platform}
          </button>
        ))}
      </div>

      {/* Active Variant */}
      {activeVariant && (
        <VariantPanel variant={activeVariant} post={post} />
      )}

      {/* Schedule Section */}
      <ScheduleSection post={post} variants={variants} nextSlotIso={nextSlotIso} />
    </div>
  );
}

function VariantPanel({ variant, post }: { variant: Variant; post: Post }) {
  const router = useRouter();
  const [captionFeedback, setCaptionFeedback] = useState("");
  const [imageFeedback, setImageFeedback] = useState("");
  const [captionMode, setCaptionMode] = useState<"view" | "revise">("view");
  const [imageMode, setImageMode] = useState<"view" | "revise">("view");
  const [loading, setLoading] = useState("");

  async function handleAction(
    target: "caption" | "image",
    action: "approve" | "revise" | "reject",
    feedback?: string,
  ) {
    setLoading(`${target}-${action}`);
    try {
      await fetch(`/api/posts/variants/${variant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action, feedback }),
      });
      setCaptionMode("view");
      setImageMode("view");
      setCaptionFeedback("");
      setImageFeedback("");
      router.refresh();
    } finally {
      setLoading("");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Image Panel */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Image
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[variant.imageStatus]}`}
          >
            {variant.imageStatus}
          </span>
        </div>

        {variant.imageUrl ? (
          <div className="mb-4 overflow-hidden rounded-lg border border-zinc-100">
            <img
              src={variant.imageUrl}
              alt="Generated post image"
              className="w-full"
            />
          </div>
        ) : (
          <div className="mb-4 flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 bg-zinc-50">
            <div className="text-center">
              <ImageIcon size={32} className="mx-auto mb-2 text-zinc-300" />
              <p className="text-sm text-zinc-400">
                {post.sourceType === "ai-caption-only"
                  ? "Upload a photo for this post"
                  : "Image not yet generated"}
              </p>
            </div>
          </div>
        )}

        {variant.imageStatus !== "approved" && (
          <>
            {imageMode === "view" && (
              <div className="flex gap-2">
                {variant.imageUrl && (
                  <button
                    onClick={() => handleAction("image", "approve")}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    <Check size={12} /> Approve
                  </button>
                )}
                <button
                  onClick={() => setImageMode("revise")}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-200"
                >
                  <RotateCcw size={12} /> Regenerate
                </button>
                {variant.imageUrl && (
                  <button
                    onClick={() => handleAction("image", "reject")}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-200 disabled:opacity-50"
                  >
                    <X size={12} /> Reject
                  </button>
                )}
              </div>
            )}
            {imageMode === "revise" && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={imageFeedback}
                  onChange={(e) => setImageFeedback(e.target.value)}
                  placeholder='e.g., "warmer tones", "show more of the house"'
                  autoFocus
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction("image", "revise", imageFeedback)}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    <Sparkles size={12} />{" "}
                    {loading === "image-revise" ? "Regenerating…" : "Regenerate"}
                  </button>
                  <button
                    onClick={() => { setImageMode("view"); setImageFeedback(""); }}
                    className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-600"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {variant.imageStatus === "approved" && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <Check size={12} /> Image approved
          </p>
        )}
      </div>

      {/* Caption Panel */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Caption
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[variant.captionStatus]}`}
          >
            {variant.captionStatus}
          </span>
        </div>

        <div className="mb-4 min-h-[160px] whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 text-sm text-zinc-700">
          {variant.caption || "No caption generated yet."}
        </div>

        {variant.captionStatus !== "approved" && (
          <>
            {captionMode === "view" && (
              <div className="flex gap-2">
                {variant.caption && (
                  <button
                    onClick={() => handleAction("caption", "approve")}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    <Check size={12} /> Approve
                  </button>
                )}
                <button
                  onClick={() => setCaptionMode("revise")}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-200"
                >
                  <RotateCcw size={12} /> Revise
                </button>
                {variant.caption && (
                  <button
                    onClick={() => handleAction("caption", "reject")}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-200 disabled:opacity-50"
                  >
                    <X size={12} /> Reject
                  </button>
                )}
              </div>
            )}
            {captionMode === "revise" && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={captionFeedback}
                  onChange={(e) => setCaptionFeedback(e.target.value)}
                  placeholder='e.g., "shorter", "more urgent", "add emoji"'
                  autoFocus
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction("caption", "revise", captionFeedback)}
                    disabled={!!loading}
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    <RotateCcw size={12} />{" "}
                    {loading === "caption-revise" ? "Revising…" : "Revise Caption"}
                  </button>
                  <button
                    onClick={() => { setCaptionMode("view"); setCaptionFeedback(""); }}
                    className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-600"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {variant.captionStatus === "approved" && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <Check size={12} /> Caption approved
          </p>
        )}
      </div>
    </div>
  );
}

function PostStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "bg-zinc-100 text-zinc-500",
    generating: "bg-blue-100 text-blue-700",
    review: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    scheduled: "bg-indigo-100 text-indigo-700",
    published: "bg-emerald-100 text-emerald-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[status] ?? styles.draft}`}
    >
      {status}
    </span>
  );
}
