"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Obligation, ObligationCategory } from "@aac/items";
import { useItems } from "../items-context";

const CATEGORY: Record<ObligationCategory, string> = {
  insurance: "Insurance",
  license: "License",
  entity: "Entity",
  tax: "Tax and payroll",
  membership: "Membership",
  software: "Software",
  vehicle: "Vehicle",
  safety: "Safety",
};
const REPEAT = { none: "Once", quarterly: "Quarterly", yearly: "Yearly", "2-yearly": "Every 2 years", "4-yearly": "Every 4 years" } as const;

const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthOf = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const daysUntil = (day: string, today: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);

/** Admin's Important dates: every renewal, license, filing and membership with its next date (cc:obligations). */
export function ImportantDates({ initial, today }: { initial: Obligation[]; today: string }) {
  const [list, setList] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { say, reload } = useItems();
  const router = useRouter();

  const post = async (body: Record<string, unknown>, ok: string) => {
    const res = await fetch("/api/obligations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { obligations?: Obligation[]; error?: string };
    if (!res.ok || !json.obligations) return say(json.error ?? "That didn't save");
    setList(json.obligations);
    setEditing(null);
    say(ok);
    await reload();
    router.refresh();
  };

  const open = list.filter((o) => !o.closed);
  const dated = open.filter((o) => o.due).sort((a, b) => a.due!.localeCompare(b.due!));
  const undated = open.filter((o) => !o.due);
  const months = [...new Set(dated.map((o) => monthOf(o.due!)))];

  const row = (o: Obligation) => {
    const d = o.due ? daysUntil(o.due, today) : null;
    const tone = d == null ? "" : d <= 0 ? "red" : d <= 7 ? "amber" : d <= o.leadDays ? "info" : "";
    return (
      <div key={o.id} className={`item ${tone}`}>
        <div className="row">
          <div className="body">
            <div className="title" style={{ cursor: "default" }}>
              {o.title}
            </div>
            <div className="meta">
              {o.due && <span className={`tag${d != null && d <= 0 ? " red" : ""}`}>{d != null && d < 0 ? `${-d}d overdue · ` : ""}{fmt(o.due)}</span>}
              <span className="tag">{CATEGORY[o.category]}</span>
              <span className="tag">{REPEAT[o.repeat]}</span>
              {o.handledBy && <span className="tag">{o.handledBy} handles it</span>}
              {o.cost && <span className="tag num">{o.cost}</span>}
              {o.sensitive && <span className="tag sens">{o.sensitive === "money" ? "Money" : "Legal"}</span>}
              {!o.confirmed && <span className="tag auto">Date not confirmed</span>}
              {o.lastDone && <span className="tag">Last done {fmt(o.lastDone)}</span>}
            </div>
            {(o.notes || o.source) && <div className="evidence">{[o.notes, o.source ? `From: ${o.source}` : ""].filter(Boolean).join(" ")}</div>}
            {editing === o.id && (
              <div className="chips" style={{ marginTop: 8 }}>
                <input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} className="btn" />
                <button className="btn sm primary" type="button" disabled={!draft} onClick={() => post({ op: "set", id: o.id, due: draft, confirmed: true }, "Date saved")}>
                  Save
                </button>
                <button className="btn sm" type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="acts">
            {o.due && !o.confirmed && editing !== o.id && (
              <button className="btn sm" type="button" onClick={() => post({ op: "set", id: o.id, due: o.due, confirmed: true }, "Confirmed")}>
                Confirm
              </button>
            )}
            {editing !== o.id && (
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  setEditing(o.id);
                  setDraft(o.due ?? "");
                }}
              >
                {o.due ? "Change date" : "Add date"}
              </button>
            )}
            {o.due && (
              <button className="btn sm primary" type="button" onClick={() => post({ op: "done", id: o.id }, o.repeat === "none" ? "Done" : "Done, moved to the next date")}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="card" id="dates">
      <div className="sec-h">
        <h3>Important dates</h3>
        <span className="hint">
          {dated.length} dated, {undated.length} need a date, {open.filter((o) => !o.confirmed).length} to confirm
        </span>
      </div>
      {!open.length && <div className="empty">No dates yet.</div>}
      {months.map((m) => (
        <section className="sec" key={m}>
          <div className="sec-h">
            <h2>{m}</h2>
          </div>
          <div className="list">{dated.filter((o) => monthOf(o.due!) === m).map(row)}</div>
        </section>
      ))}
      {undated.length > 0 && (
        <section className="sec">
          <div className="sec-h">
            <h2>Needs a date</h2>
            <span className="hint">These never show up on This week until they have one</span>
          </div>
          <div className="list">{undated.map(row)}</div>
        </section>
      )}
      <div className="note">
        Each date shows up as an item in the days before it (two weeks for most, longer for the GL application and the CSL&apos;s CE hours), pinned
        to its day on This week, on Today from a week out (a switch on Rules), and red from the day it&apos;s due. Done moves a repeating date to its next one. When someone else files it
        (Datapay, the CPA, Titan), the item asks you to check that it happened.
      </div>
    </div>
  );
}
