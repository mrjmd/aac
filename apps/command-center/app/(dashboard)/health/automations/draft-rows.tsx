"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import type { HandGradeValue, Outcome } from "@aac/grader";
import { wordDiff } from "@/lib/word-diff";

export interface DraftRowData {
  id: string;
  isQuote: boolean;
  date: string;
  who: string;
  kind: string;
  outcome: Outcome;
  autoGrade: string;
  hand: HandGradeValue | null;
  drafted: string;
  sent: string;
  match: string;
  changes: string[];
  note: string;
  draftText: string;
  sentText: string;
  lines: string[];
}

const OUT: Record<Outcome, [string, string]> = {
  right: ["on", "Right"],
  changed: ["risk", "Changed"],
  "thrown-out": ["off", "Thrown out"],
  hurt: ["off", "Would have hurt"],
  unused: ["nd", "Not used"],
  waiting: ["nd", "Not graded yet"],
};

const HAND: Array<[HandGradeValue, string]> = [
  ["as-is", "As drafted"],
  ["cosmetic", "Light edit"],
  ["changed", "Real change"],
  ["thrown-out", "Thrown out"],
  ["hurt", "Would have hurt"],
];

export function DraftRows({ rows }: { rows: DraftRowData[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quote = rows[0]?.isQuote ?? false;
  const cols = 8;

  async function grade(id: string, g: HandGradeValue | null) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/automations/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, grade: g }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tbl-wrap">
      {error && <div className="callout" style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)" }}>Couldn&apos;t save the grade: {error}</div>}
      <table>
        <thead>
          <tr>
            <th>Drafted</th>
            <th>{quote ? "Quote" : "Customer"}</th>
            <th>Kind</th>
            <th className="r">{quote ? "It drafted" : "Match"}</th>
            {quote && <th className="r">You sent</th>}
            <th>Outcome</th>
            <th>{quote ? "What changed" : "Your grade"}</th>
            {quote && <th>Your grade</th>}
            {!quote && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open === r.id;
            const [cls, label] = OUT[r.outcome];
            return (
              <Fragment key={r.id}>
                <tr className={`am-row${isOpen ? " open" : ""}`} onClick={() => setOpen(isOpen ? null : r.id)}>
                  <td className="num">{r.date}</td>
                  <td>{r.who}</td>
                  <td>
                    <span className="tag">{r.kind}</span>
                  </td>
                  <td className="r num">{quote ? r.drafted : r.match}</td>
                  {quote && <td className="r num">{r.sent}</td>}
                  <td>
                    <span className={`st ${cls}`}>{label}</span>
                  </td>
                  {quote && <td className="wrapc">{r.changes.length ? r.changes.join("; ") : r.note}</td>}
                  <td>{r.hand ? <span className="tag ai">{HAND.find(([g]) => g === r.hand)?.[1]}</span> : <span className="am-muted">{r.outcome === "waiting" ? "" : "Grade"}</span>}</td>
                  {!quote && <td className="am-muted">{isOpen ? "▴" : "▾"}</td>}
                </tr>
                {isOpen && (
                  <tr className="am-detail">
                    <td colSpan={cols}>
                      {quote ? (
                        <div className="diff">
                          <div>
                            <span className="micro">It drafted</span>
                            {r.lines.length ? r.lines.map((l) => <div key={l}>{l}</div>) : "No lines recorded"}
                          </div>
                          <div>
                            <span className="micro">What you changed</span>
                            {r.changes.length ? r.changes.map((c) => <div key={c}>{c}</div>) : r.note || "Nothing"}
                          </div>
                        </div>
                      ) : (
                        <div className="diff">
                          <div>
                            <span className="micro">It drafted</span>
                            <span className="am-text">
                              {r.sentText ? wordDiff(r.draftText, r.sentText).map((p, i) => (p.t === "same" ? <span key={i}>{p.a ?? p.s}</span> : p.t === "del" ? <del key={i}>{p.s}</del> : null)) : r.draftText}
                            </span>
                          </div>
                          <div>
                            <span className="micro">You sent</span>
                            <span className="am-text">
                              {r.sentText
                                ? wordDiff(r.draftText, r.sentText).map((p, i) => (p.t === "same" ? <span key={i}>{p.s}</span> : p.t === "ins" ? <ins key={i}>{p.s}</ins> : null))
                                : r.note || "Nothing yet"}
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="am-grade">
                        <span className="am-muted">
                          Grader says <b>{r.autoGrade}</b>
                          {r.note && !quote && r.sentText ? ` · ${r.note}` : ""}. Your grade:
                        </span>
                        {HAND.map(([g, l]) => (
                          <button
                            key={g}
                            className={`btn sm${r.hand === g ? " primary" : ""}`}
                            disabled={busy === r.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void grade(r.id, r.hand === g ? null : g);
                            }}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
