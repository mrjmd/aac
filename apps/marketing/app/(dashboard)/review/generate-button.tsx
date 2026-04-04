"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

const PILLARS = [
  { value: "", label: "Any pillar" },
  { value: "educational", label: "Educational" },
  { value: "showcase", label: "Showcase" },
  { value: "seasonal", label: "Seasonal / Weather" },
  { value: "testimonial", label: "Testimonial" },
  { value: "personality", label: "Personality" },
  { value: "blog", label: "Blog Promotion" },
];

const COUNT_OPTIONS = [3, 5, 8, 10];

export function GenerateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pillar, setPillar] = useState("");
  const [theme, setTheme] = useState("");
  const [count, setCount] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleGenerate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/ideas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count,
          ...(pillar ? { pillar } : {}),
          ...(theme.trim() ? { theme: theme.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          setError(data.error ?? "Generation failed");
        } catch {
          setError(`Server error (${res.status}): ${text.slice(0, 200)}`);
        }
        return;
      }
      setOpen(false);
      setPillar("");
      setTheme("");
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-xl border-2 border-aac-dark bg-aac-yellow px-4 py-2.5 text-xs font-black uppercase tracking-widest text-aac-dark shadow-[4px_4px_0px_0px_rgba(26,26,26,1)] transition-transform hover:translate-y-[-2px]"
      >
        <Sparkles size={14} />
        Generate Ideas
      </button>
    );
  }

  return (
    <div className="w-72 rounded-xl border border-zinc-200 bg-white p-4 shadow-lg">
      <p className="mb-3 text-sm font-semibold text-aac-dark">
        Generate Ideas
      </p>

      <select
        value={pillar}
        onChange={(e) => setPillar(e.target.value)}
        className="mb-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
      >
        {PILLARS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        placeholder="Optional theme or prompt…"
        className="mb-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-aac-blue"
      />

      <div className="mb-3">
        <p className="mb-1.5 text-xs text-zinc-400">Number of ideas</p>
        <div className="flex gap-1.5">
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => setCount(n)}
              className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors ${
                count === n
                  ? "bg-aac-blue text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex-1 rounded-lg bg-aac-blue px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-aac-blue/90 disabled:opacity-50"
        >
          {loading ? "Generating…" : `Generate ${count} Ideas`}
        </button>
        <button
          onClick={() => { setOpen(false); setError(""); }}
          className="rounded-lg px-3 py-2 text-xs text-zinc-400 hover:text-zinc-600"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
