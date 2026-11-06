"use client";

import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { isPending, TOPIC_STATUS_LABEL, type Person, type PersonEventKind, type Topic, type TopicStatus } from "@aac/items/people";
import { useItems } from "../items-context";
import { usePeople } from "../people-context";

const ST_CLASS: Record<TopicStatus, string> = { ready: "on", prep: "nd", fup: "risk" };
const NEXT_ST: Record<TopicStatus, TopicStatus> = { prep: "ready", ready: "fup", fup: "prep" };
const KIND_LABEL: Record<PersonEventKind, string> = { call: "Call", meet: "In person", text: "Text", note: "Note" };
export const KIND_ICON: Record<PersonEventKind, string> = { call: "C", meet: "M", text: "T", note: "N" };

export const pendingPeople = (people: Person[]) => people.filter(isPending);

type Form = null | "topic" | "had";

/** The mockup's agenda card: open topics, Had it, + Topic. Same card on Today and People. */
export function PersonCard({ person }: { person: Person }) {
  const { change } = usePeople();
  const { say } = useItems();
  const [form, setForm] = useState<Form>(null);
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [kind, setKind] = useState<PersonEventKind>("meet");
  const [decided, setDecided] = useState("");
  const [followUp, setFollowUp] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Dragged order, shown until the save comes back as the person's own order.
  const [order, setOrder] = useState<string[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const topics = order ? order.map((id) => person.topics.find((t) => t.id === id)).filter((t): t is Topic => !!t) : person.topics;
  useEffect(() => setOrder(null), [person]);

  const changeRef = useRef(change);
  changeRef.current = change;
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => {
    if (!listRef.current) return;
    const s = Sortable.create(listRef.current, {
      handle: ".grip",
      animation: 150,
      // Pointer events rather than native drag and drop: same on mouse and touch.
      forceFallback: true,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      filter: ".empty",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const ids = Array.from(evt.to.querySelectorAll<HTMLElement>(":scope > .topic")).map((el) => el.dataset.id!);
        // React owns the DOM: put the moved node back and re-render in the new order.
        evt.item.remove();
        evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex ?? 0] ?? null);
        setOrder(ids);
        void changeRef.current({ id: person.id, op: "reorder", topicIds: ids }).then((saved) => {
          if (!saved) {
            setOrder(null);
            sayRef.current("That order didn't save");
          }
        });
      },
    });
    return () => s.destroy();
  }, [person.id]);

  const send = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const saved = await change({ id: person.id, ...body });
      say(saved ? ok : "That didn't save");
      return saved;
    } finally {
      setBusy(false);
    }
  };

  // One topic touched on: off the agenda into today's Addressed entry, with Undo.
  const address = async (t: Topic) => {
    setBusy(true);
    try {
      const saved = await change({ id: person.id, op: "addressed", topicId: t.id });
      if (!saved) return say("That didn't save");
      const at = saved.history[0]?.at;
      say(`Addressed: ${t.title}`, async () => {
        if (!(await change({ id: person.id, op: "reopen", topic: t, at }))) say("Undo didn't save");
      });
    } finally {
      setBusy(false);
    }
  };

  const addTopic = async () => {
    if (!title.trim()) return;
    if (await send({ op: "addTopic", title, why }, `Added to ${person.name}'s agenda`)) {
      setTitle("");
      setWhy("");
      setForm(null);
    }
  };
  const had = async () => {
    const saved = await send(
      { op: "had", kind, decided, followUp },
      followUp.length ? `Logged. ${followUp.length} topic${followUp.length === 1 ? "" : "s"} kept as Follow up.` : "Logged",
    );
    if (saved) {
      setDecided("");
      setFollowUp([]);
      setForm(null);
    }
  };

  return (
    <div className="pcard">
      <div className="who">
        <b>{person.name}</b>
        <span className="micro">
          {person.role}
          {person.when ? ` · ${person.when}` : ""}
        </span>
      </div>
      <div ref={listRef}>
      {topics.length ? (
        topics.map((t) => (
          <div key={t.id} className="topic" data-id={t.id}>
            <span className="grip" title="Drag to reorder" aria-hidden="true">
              ⠿
            </span>
            <input
              type="checkbox"
              className="tick"
              checked={false}
              title="Addressed: check off just this one"
              aria-label={`Addressed: ${t.title}`}
              disabled={busy}
              onChange={() => address(t)}
            />
            <div className="n">
              {t.title}
              {t.why && <div className="why">{t.why}</div>}
            </div>
            <button
              className={`st btnlike ${ST_CLASS[t.status]}`}
              type="button"
              title="Change status"
              disabled={busy}
              onClick={() => send({ op: "topicStatus", topicId: t.id, status: NEXT_ST[t.status] }, TOPIC_STATUS_LABEL[NEXT_ST[t.status]])}
            >
              {TOPIC_STATUS_LABEL[t.status]}
            </button>
            <button
              className="btn sm ghost"
              type="button"
              aria-label="Remove topic"
              disabled={busy}
              onClick={() => send({ op: "removeTopic", topicId: t.id }, "Topic removed")}
            >
              ×
            </button>
          </div>
        ))
      ) : (
        <div className="empty">No open topics. Add one, or send any item here with ⋯.</div>
      )}
      </div>

      {form === "topic" && (
        <div className="pform">
          <input type="text" placeholder="Topic" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <input type="text" placeholder="Why it matters (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
          <div className="chips">
            <button className="btn sm primary" type="button" disabled={busy || !title.trim()} onClick={addTopic}>
              Add
            </button>
            <button className="btn sm" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {form === "had" && (
        <div className="pform">
          <div className="chips">
            {(Object.keys(KIND_LABEL) as PersonEventKind[]).map((k) => (
              <button key={k} className={`btn sm${kind === k ? " dark" : ""}`} type="button" onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <textarea rows={3} placeholder="What was decided" value={decided} autoFocus onChange={(e) => setDecided(e.target.value)} />
          {person.topics.length > 0 && <span className="lbl">Still open? Tick to keep as Follow up</span>}
          {person.topics.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={followUp.includes(t.id)}
                onChange={(e) => setFollowUp(e.target.checked ? [...followUp, t.id] : followUp.filter((x) => x !== t.id))}
              />
              {t.title}
            </label>
          ))}
          <div className="chips">
            <button className="btn sm primary" type="button" disabled={busy} onClick={had}>
              Log it
            </button>
            <button className="btn sm" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {form === null && (
        <div className="a">
          {person.topics.length > 0 && (
            <button className="btn sm primary" type="button" onClick={() => setForm("had")}>
              Had it
            </button>
          )}
          <button className="btn sm" type="button" onClick={() => setForm("topic")}>
            + Topic
          </button>
        </div>
      )}
    </div>
  );
}
