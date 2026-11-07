"use client";

import { useState } from "react";
import type { CardFlag } from "@/lib/card-flags";
import { ago } from "../components/items";
import { useItems } from "../items-context";

/** System's "You flagged": every "this looks wrong" tap, open ones first, fixed ones with what changed. */
export function CardFlags({ initial }: { initial: CardFlag[] }) {
  const [flags, setFlags] = useState(initial);
  const [shown, setShown] = useState<string | null>(null);
  const { say } = useItems();
  const open = flags.filter((f) => !f.fixedAt);
  const fixed = flags.filter((f) => f.fixedAt).slice(0, 10);

  const fix = async (id: string) => {
    const res = await fetch("/api/card-flags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "fix", id }) });
    if (!res.ok) return say("That didn't save");
    const { flag } = (await res.json()) as { flag: CardFlag };
    setFlags((all) => all.map((f) => (f.id === id ? flag : f)));
    say("Marked fixed");
  };

  const row = (f: CardFlag) => (
    <div key={f.id} className={`item${f.fixedAt ? "" : " amber"}`}>
      <div className="row">
        <div className="body">
          <div className="title" style={{ cursor: "default" }}>
            {f.note || "No note"}
          </div>
          <div className="meta">
            <span className="tag">{f.card}</span>
            <span className="tag">{f.page}</span>
            <span className="tag">{f.fixedAt ? `Fixed ${ago(f.fixedAt)}` : `Flagged ${ago(f.at)}`}</span>
          </div>
          {f.fix && <div className="evidence">Fix: {f.fix}</div>}
          {shown === f.id && <pre className="evidence" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{f.text}</pre>}
        </div>
        <div className="acts">
          <button className="btn sm" type="button" onClick={() => setShown(shown === f.id ? null : f.id)}>
            {shown === f.id ? "Hide card" : "What it showed"}
          </button>
          {!f.fixedAt && (
            <button className="btn sm" type="button" onClick={() => fix(f.id)}>
              Mark fixed
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="sec-h">
        <h3>You flagged · {open.length}</h3>
        <span className="hint">&ldquo;Looks wrong?&rdquo; on any card. These get fixed first, next session.</span>
      </div>
      <div className="list">{open.length ? open.map(row) : <div className="empty">Nothing open. Hover any card or tile and tap &ldquo;Looks wrong?&rdquo;.</div>}</div>
      {fixed.length > 0 && (
        <details className="fold">
          <summary>Recently fixed · {fixed.length}</summary>
          <div className="list">{fixed.map(row)}</div>
        </details>
      )}
    </div>
  );
}
