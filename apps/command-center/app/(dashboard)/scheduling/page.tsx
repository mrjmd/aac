import { fetchPendingDirectives } from "@/lib/scheduling";
import type { SchedulingDirective } from "@aac/scheduling";

export const revalidate = 15;

export default async function SchedulingPage() {
  let result;
  try {
    result = await fetchPendingDirectives(100);
  } catch (error) {
    return (
      <div>
        <h2 className="font-display mb-6 text-2xl font-bold">Scheduling</h2>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="font-medium text-red-700">Could not read directive queue</p>
          <p className="mt-1 text-sm text-red-500">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  const { directives, totalIds, fetched, staleIds } = result;

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-bold">Scheduling</h2>
        <p className="text-xs text-zinc-400">
          {fetched} of {totalIds} pending
          {staleIds.length > 0 && (
            <span className="ml-2 text-amber-600">
              · {staleIds.length} stale id{staleIds.length === 1 ? "" : "s"}
            </span>
          )}
        </p>
      </div>

      {directives.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          <p className="font-medium text-aac-dark">No pending directives</p>
          <p className="mt-1 text-sm text-zinc-400">
            The queue is empty. Directives appear here as QB approvals and scheduling intents arrive.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {directives.map((d) => (
            <DirectiveCard key={d.id} directive={d} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────

const eventClassStyles: Record<string, string> = {
  job: "bg-emerald-100 text-emerald-700",
  assessment: "bg-purple-100 text-purple-700",
  callback: "bg-amber-100 text-amber-700",
};

const intentLabels: Record<SchedulingDirective["intent"], string> = {
  quote_approved: "Quote approved",
  assessment_requested: "Assessment requested",
  callback_opened: "Callback opened",
  manual_schedule: "Manual schedule",
};

function DirectiveCard({ directive }: { directive: SchedulingDirective }) {
  const created = new Date(directive.createdAt);
  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-5">
      {/* Header */}
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-aac-blue/10 px-2.5 py-0.5 text-xs font-semibold text-aac-blue">
          {intentLabels[directive.intent]}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            eventClassStyles[directive.eventClass] ?? "bg-zinc-100 text-zinc-700"
          }`}
        >
          {directive.eventClass}
        </span>
        <span className="text-xs text-zinc-400">{directive.source}</span>
        <span className="ml-auto text-xs text-zinc-400" title={directive.createdAt}>
          {created.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </header>

      {/* Customer + entity refs */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
            Customer phone
          </p>
          <p className="font-mono text-sm text-aac-dark">
            {directive.customerPhone || <span className="text-zinc-400">(none)</span>}
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          {directive.qbEstimateId && (
            <span className="mr-3">
              QB Estimate <span className="font-mono">#{directive.qbEstimateId}</span>
            </span>
          )}
          {directive.pdPersonId && (
            <span className="mr-3">
              PD Person <span className="font-mono">{directive.pdPersonId}</span>
            </span>
          )}
          {directive.pdDealId && (
            <span>
              PD Deal <span className="font-mono">{directive.pdDealId}</span>
            </span>
          )}
        </div>
      </div>

      {/* Scope */}
      <div className="mb-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
          Scope
        </p>
        {directive.scopeSummary ? (
          directive.scopeSummary.length > 240 ? (
            <details>
              <summary className="cursor-pointer list-none text-sm text-aac-dark [&::-webkit-details-marker]:hidden">
                <span className="line-clamp-2">{directive.scopeSummary}</span>
                <span className="mt-1 inline-block text-xs text-zinc-400 hover:text-aac-blue">
                  show full scope
                </span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-aac-dark">
                {directive.scopeSummary}
              </p>
            </details>
          ) : (
            <p className="text-sm text-aac-dark">{directive.scopeSummary}</p>
          )
        ) : (
          <span className="text-sm text-zinc-400">(no summary)</span>
        )}
      </div>

      {/* Duration prediction */}
      <DurationBlock directive={directive} />

      {/* Confidence */}
      <ConfidenceBlock directive={directive} />

      {/* Raw JSON (for debugging) */}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600">
          Raw directive
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-700">
          {JSON.stringify(directive, null, 2)}
        </pre>
      </details>
    </article>
  );
}

// ── Duration prediction block ─────────────────────────────────────

function DurationBlock({ directive }: { directive: SchedulingDirective }) {
  const p = directive.durationPrediction;
  if (!p) {
    const reason = directive.qbEstimateId
      ? "Directive predates the @aac/quoting wire-up. Will populate on next directive from this trigger path."
      : "Trigger path doesn't carry a QB Estimate (e.g., assessment_requested or text-only manual_schedule).";
    return (
      <div className="mb-3 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
        <p className="font-medium text-zinc-600">No duration prediction</p>
        <p className="mt-0.5">{reason}</p>
      </div>
    );
  }

  const confidenceColor =
    p.confidence === "high"
      ? "bg-emerald-100 text-emerald-700"
      : p.confidence === "moderate"
        ? "bg-sky-100 text-sky-700"
        : p.confidence === "low"
          ? "bg-amber-100 text-amber-700"
          : "bg-zinc-100 text-zinc-600";

  return (
    <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
          Duration
        </p>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceColor}`}>
          {p.confidence}
        </span>
        <span className="text-xs text-zinc-500">{p.category.replace(/_/g, " ")}</span>
      </div>

      <div className="mb-2 flex items-baseline gap-3">
        <p className="text-lg font-bold text-aac-dark">
          {p.point !== null ? `${p.point}h` : "—"}
        </p>
        {p.p25 !== null && p.p75 !== null && (
          <p className="text-xs text-zinc-500">
            range {p.p25}–{p.p75}h · cv {p.cv}
          </p>
        )}
      </div>

      <p className="mb-3 text-xs text-zinc-600">{p.rationale}</p>

      {p.similar.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-aac-blue">
            {p.similar.length} similar past case{p.similar.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1.5 text-xs">
            {p.similar.map((s, i) => (
              <li key={i} className="rounded-md bg-white px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-aac-dark">{s.customerToken}</span>
                  <span className="text-zinc-500">${s.totalAmt.toLocaleString()}</span>
                  <span className="font-semibold text-aac-blue">{s.durationHours}h</span>
                  <span className="ml-auto text-[10px] text-zinc-400">
                    distance {s.distance}
                  </span>
                </div>
                {s.scopeSnippet && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                    {s.scopeSnippet}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Confidence block ──────────────────────────────────────────────

function ConfidenceBlock({ directive }: { directive: SchedulingDirective }) {
  const c = directive.confidence;
  const pct = Math.round(c.score * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
        Confidence
      </span>
      <div className="relative h-1.5 w-24 overflow-hidden rounded-full bg-zinc-100">
        <div
          className="absolute inset-y-0 left-0 bg-aac-blue"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-semibold text-aac-dark">{pct}%</span>
      <div className="flex flex-wrap gap-1">
        {c.signals.map((s) => (
          <span
            key={s}
            className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600"
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
