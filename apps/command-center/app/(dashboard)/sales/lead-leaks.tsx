"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LeadLeakSnapshot, LeakRow, LeakStage } from "@aac/lead-leaks";
import { useItems } from "../items-context";

const STAGES: Array<{ key: LeakStage; title: string; hint: string }> = [
  { key: "no_reply", title: "Asked, never got an answer", hint: "No photos or details yet" },
  { key: "no_quote", title: "Sent photos or details, no quote", hint: "The quote is ours to send" },
  { key: "assessed", title: "Assessed, never quoted", hint: "We visited" },
];

/** threadFacts describes a last call in words ("missed call", "call, 3 min"); only texts get the quote box. */
const CALL_TEXT = /^(missed call|unanswered call|voicemail|call, \d+ min)$/;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const phoneText = (p: string) => (p.startsWith("+1") && p.length === 12 ? `${p.slice(2, 5)}-${p.slice(5, 8)}-${p.slice(8)}` : p);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const daysAgo = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));

/** Leads we dropped before a quote, last 90 days (`@aac/lead-leaks`, built nightly by the worker). */
export function LeadLeaksCard({ snapshot, handled: initial }: { snapshot: LeadLeakSnapshot | null; handled: Record<string, string> }) {
  const [handled, setHandled] = useState(initial);
  const [showQuiet, setShowQuiet] = useState(false);
  const { say } = useItems();
  const router = useRouter();

  if (!snapshot) {
    return (
      <div className="card">
        <h3>Lead leaks</h3>
        <div className="empty">Not built yet. The worker builds it every night.</div>
      </div>
    );
  }

  const now = Date.parse(snapshot.builtAt);
  const open = snapshot.rows.filter((r) => handled[r.phone] !== r.lastActivityAt);
  const total = open.reduce((s, r) => s + r.value, 0);
  const recent = open.filter((r) => daysAgo(r.lastAt, now) <= 35);
  const built = new Date(snapshot.builtAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

  const mark = async (r: LeakRow, on: boolean) => {
    const res = await fetch("/api/lead-leaks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: r.phone, lastActivityAt: on ? r.lastActivityAt : null }),
    });
    if (!res.ok) return say("That didn't save");
    setHandled((h) => {
      const next = { ...h };
      if (on) next[r.phone] = r.lastActivityAt;
      else delete next[r.phone];
      return next;
    });
    router.refresh();
    if (on) say(`${r.name ?? phoneText(r.phone)} marked handled`, () => mark(r, false));
  };

  return (
    <div className="card">
      <div className="sec-h">
        <h3>Lead leaks, last {snapshot.windowDays} days</h3>
        <span className="hint">Built {built}, nightly</span>
      </div>
      <div className="tiles">
        <div className="tile">
          <div className="k">Open</div>
          <div className="v num">{usd(total)}</div>
          <div className="s">{open.length} leads we dropped before a quote</div>
        </div>
        <div className="tile">
          <div className="k">Last 5 weeks</div>
          <div className="v num">{usd(recent.reduce((s, r) => s + r.value, 0))}</div>
          <div className="s">{recent.length} still warm enough to win</div>
        </div>
        {STAGES.map((s) => {
          const rows = open.filter((r) => r.stage === s.key);
          return (
            <div className="tile" key={s.key}>
              <div className="k">{s.title}</div>
              <div className="v num">{rows.length}</div>
              <div className="s">{usd(rows.reduce((t, r) => t + r.value, 0))}</div>
            </div>
          );
        })}
      </div>
      {(snapshot.partial || snapshot.gaps.length > 0) && <div className="callout">Not complete: {snapshot.gaps.join("; ")}</div>}
      {STAGES.map((s) => {
        const rows = open.filter((r) => r.stage === s.key);
        if (!rows.length) return null;
        return (
          <div className="sec" key={s.key}>
            <div className="sec-h">
              <h2>{s.title}</h2>
              <span className="hint">{s.hint}</span>
            </div>
            <div className="list">
              {rows.map((r) => {
                const age = daysAgo(r.lastAt, now);
                return (
                  <div key={r.phone} className={`item ${r.lastWho === "them" && age <= 14 ? "red" : age <= 35 ? "amber" : ""}`}>
                    <div className="row">
                      <div className="body">
                        <div className="title" style={{ cursor: "default" }}>
                          {r.name ?? "Unknown"} <span className="num" style={{ fontWeight: 500, color: "var(--ink-2)" }}>{phoneText(r.phone)}</span>
                        </div>
                        <div style={{ fontSize: 13, marginTop: 3 }}>{r.askedFor}</div>
                        <div style={{ fontSize: 13, marginTop: 3, color: "var(--ink-2)" }}>{r.whyStuck}</div>
                        <div className="meta">
                          <span className="tag">{r.lastWho === "them" ? "They spoke last" : "We spoke last"} {day(r.lastAt)}</span>
                          <span className="tag">First {day(r.firstAt)}</span>
                          {r.photos > 0 && <span className="tag">{r.photos} photos</span>}
                          <span className="tag" title={r.valueBasis}>{usd(r.value)}</span>
                        </div>
                        {r.lastText && r.lastWho === "them" && !CALL_TEXT.test(r.lastText) && (
                          <div className="note" style={{ marginTop: 6 }}>&ldquo;{r.lastText}&rdquo;</div>
                        )}
                      </div>
                      <button className="btn sm" onClick={() => mark(r, true)} title="Hide until they write again">
                        Handled
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {!open.length && <div className="empty">Nothing dropped. Every lead in the window got an answer or a quote.</div>}
      {snapshot.quiet.length > 0 && (
        <details className="fold" open={showQuiet} onToggle={(e) => setShowQuiet((e.target as HTMLDetailsElement).open)}>
          <summary>Went quiet after we asked ({snapshot.quiet.length}), not counted</summary>
          <div className="list" style={{ marginTop: 8 }}>
            {snapshot.quiet.map((q) => (
              <div key={q.phone} style={{ fontSize: 13 }}>
                <b>{q.name ?? "Unknown"}</b> <span className="num">{phoneText(q.phone)}</span>, {q.askedFor} ({day(q.lastAt)})
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="note">
        Value = likely ticket × 54% win rate when the scope is known, else one average lead ($842 = 0.75 quotes per lead × 54% × $2,073
        average job). A bare missed call counts a quarter lead for a week. Everyone else who wrote or called in the window:{" "}
        {snapshot.quiet.length} went quiet, {snapshot.counts.quoted_or_booked} quoted or booked, {snapshot.counts.solicitation}{" "}
        solicitations, {snapshot.counts.existing_customer} existing customers, {snapshot.counts.phone_tag} phone tag,{" "}
        {snapshot.counts.declined + snapshot.counts.deferred + snapshot.counts.ct + snapshot.counts.other} declined, deferred, CT or other.
        Quotes that went stale after sending are the stale-quote follow-up&apos;s job, not this list. Handled hides a lead until they write again.
      </div>
    </div>
  );
}
