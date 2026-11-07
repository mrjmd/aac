"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useItems } from "../items-context";

const TARGET = ".card, .tile";

/** A card's heading as written (not CSS-uppercased), minus its ⓘ / ↻ buttons; else its first line. */
function titleOf(el: HTMLElement): string {
  const h = el.querySelector<HTMLElement>("h3, h2, .k")?.cloneNode(true) as HTMLElement | undefined;
  h?.querySelectorAll("button").forEach((b) => b.remove());
  return (h?.textContent?.replace(/\s+/g, " ") || el.innerText.split("\n")[0] || "").trim().slice(0, 200);
}

/**
 * "This looks wrong" on every card and tile in main: hover (or tap) a card
 * and a small button shows at its corner; it saves the card's text as it
 * is on screen plus a note (lib/card-flags.ts). One mount in the layout,
 * so no page has to wire it.
 */
export function LooksWrong() {
  const pathname = usePathname();
  const { say } = useItems();
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [open, setOpen] = useState<{ title: string; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  const place = useCallback((el: HTMLElement | null) => {
    if (!el) return setPos(null);
    const r = el.getBoundingClientRect();
    // Straddle the top border, clear of the ⓘ and ↻ buttons inside the card.
    setPos({ top: Math.max(r.top - 11, 2), left: r.right - 18 });
  }, []);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const over = (e: Event) => {
      const t = e.target as HTMLElement;
      if (btn.current?.contains(t)) return;
      const el = t.closest<HTMLElement>(TARGET);
      setCard(el && main.contains(el) ? el : null);
    };
    document.addEventListener("pointerover", over);
    return () => document.removeEventListener("pointerover", over);
  }, []);

  useEffect(() => {
    place(card);
    if (!card) return;
    const move = () => place(card);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [card, place]);

  // A new page: forget the card from the last one.
  useEffect(() => setCard(null), [pathname]);

  const save = async () => {
    if (!open) return;
    setSaving(true);
    const res = await fetch("/api/card-flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "add", page: pathname, card: open.title, note, text: open.text }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) return say("That didn't save");
    setOpen(null);
    setNote("");
    say("Saved. It gets looked at first next session; System lists it.");
  };

  return (
    <>
      {card && pos && !open && (
        <button
          ref={btn}
          type="button"
          className="lw-btn"
          style={{ top: pos.top, left: pos.left }}
          title="This looks wrong"
          onClick={() => setOpen({ title: titleOf(card), text: card.innerText.trim() })}
        >
          Looks wrong?
        </button>
      )}
      {open && (
        <div className="lw-panel" role="dialog" aria-label="This looks wrong">
          <div className="lbl">
            What looks wrong on <b>{open.title || "this card"}</b>?
          </div>
          <textarea
            autoFocus
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Dec should be $9.1k, not $4k. Or: Jean is the same person as Gene."
          />
          <div className="micro-note">The card&apos;s numbers as you see them now are saved with it.</div>
          <div className="chips">
            <button className="btn sm primary" type="button" disabled={saving || !note.trim()} onClick={save}>
              Save
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setOpen(null);
                setNote("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
