"use client";

import { useState } from "react";
import type { MuteRule, Promotion, PromotionRule } from "@aac/items";
import { DISMISS_LABEL, DismissedList } from "../components/items";
import { KIND, useItems } from "../items-context";

const since = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Mockup's Rules page: promotion switches, mutes with Unmute, the dismissed list, and what the dismissals say. */
export function RulesView({
  rules,
  promote: initial,
  mutes: initialMutes,
}: {
  rules: Array<{ id: PromotionRule; label: string; detail: string }>;
  promote: Promotion;
  mutes: MuteRule[];
}) {
  const { view, error, say, reload } = useItems();
  const [promote, setPromote] = useState(initial);
  const [mutes, setMutes] = useState(initialMutes);

  const flip = async (rule: PromotionRule) => {
    const on = !promote[rule];
    const res = await fetch("/api/items/promotion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule, on }) });
    if (!res.ok) return say("That didn't save");
    setPromote(((await res.json()) as { promote: Promotion }).promote);
    say(on ? "On. Today picks these up again." : "Off. Today stops adding these by itself.");
    await reload();
  };

  const unmute = async (m: MuteRule) => {
    const res = await fetch(`/api/items/mutes?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    if (!res.ok) return say("That didn't save");
    setMutes((all) => all.filter((x) => x.id !== m.id));
    say("Unmuted");
    await reload();
  };

  return (
    <>
      <div className="card">
        <h3>Automatic promotion</h3>
        <div className="evidence" style={{ marginTop: 0, marginBottom: 6 }}>
          What the ranking may put on Today by itself, marked Suggested. Your own drags always win.
        </div>
        {rules.map((r) => (
          <div key={r.id} className="rule">
            <span className="n">
              {r.label}
              <div className="evidence">{r.detail}</div>
            </span>
            <button
              className={`toggle${promote[r.id] ? "" : " off"}`}
              type="button"
              role="switch"
              aria-checked={promote[r.id]}
              aria-label={r.label}
              onClick={() => flip(r.id)}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Muted</h3>
        {mutes.length ? (
          mutes.map((m) => (
            <div key={m.id} className="rule">
              <span className="n">
                {KIND[m.detector] ?? m.detector}
                {m.match ? `: ${m.match}` : ", all of them"} <span className="tag">since {since(m.createdAt)}</span>
                {m.note && <div className="evidence">{m.note}</div>}
              </span>
              <button className="btn sm" type="button" onClick={() => unmute(m)}>
                Unmute
              </button>
            </div>
          ))
        ) : (
          <div className="empty">Nothing muted.</div>
        )}
      </div>

      <div className="card">
        <h3>Dismissed, last 30 days{view ? ` · ${view.dismissed.length}` : ""}</h3>
        <div className="list">{view ? <DismissedList dismissed={view.dismissed} /> : <div className="empty">{error || "Loading items…"}</div>}</div>
      </div>

      <div className="card">
        <h3>What your dismissals are teaching</h3>
        {!view ? (
          <div className="empty">{error || "Loading items…"}</div>
        ) : view.teaching.length ? (
          view.teaching.map((t) => (
            <div key={`${t.detector}|${t.reason}`} className="rule">
              <span className="n">
                &ldquo;{DISMISS_LABEL[t.reason]}&rdquo; used {t.count} times on <b>{KIND[t.detector] ?? t.detector}</b> in the last 30 days.{" "}
                {t.reason === "wrong-match"
                  ? "The name matching for that check needs work."
                  : t.reason === "not-real"
                    ? "That check is flagging things that aren't there."
                    : t.reason === "already-handled"
                      ? "That check isn't seeing where you handled it."
                      : "Worth a look at what that check is catching."}
              </span>
            </div>
          ))
        ) : (
          <div className="empty">No pattern yet. When you dismiss the same kind of item for the same reason twice, it shows here.</div>
        )}
      </div>
    </>
  );
}
