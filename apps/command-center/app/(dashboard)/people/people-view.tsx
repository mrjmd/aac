"use client";

import { useState } from "react";
import type { Person } from "@aac/items";
import { ItemCard } from "../components/items";
import { PageHeader } from "../components/layout-parts";
import { KIND_ICON, PersonCard } from "../components/people";
import { useItems } from "../items-context";
import { usePeople } from "../people-context";

function shortDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const thisYear = d.getUTCFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** Staff and partners: agenda, past conversations, tagged items, facts (the mockup's People page). */
export function PeopleView() {
  const { people, change } = usePeople();
  const { say } = useItems();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");

  const addPerson = async () => {
    const saved = await change({ op: "addPerson", name, role });
    if (!saved) return say("That didn't save");
    setName("");
    setRole("");
    setAdding(false);
    say(`${saved.name} added`);
  };

  return (
    <>
      <PageHeader
        eyebrow="Area"
        title="People"
        sub="Staff and partners: what you need to talk about, what was decided, what's owed either way"
        right={
          <button className="btn sm" type="button" onClick={() => setAdding(!adding)}>
            + Person
          </button>
        }
      />
      {adding && (
        <div className="card pform">
          <input type="text" placeholder="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <input type="text" placeholder="Role, e.g. Tech or Bookkeeper" value={role} onChange={(e) => setRole(e.target.value)} />
          <div className="chips">
            <button className="btn sm primary" type="button" disabled={!name.trim() || !role.trim()} onClick={addPerson}>
              Add
            </button>
            <button className="btn sm" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {people.length === 0 && !adding && <div className="empty">No one here yet. + Person adds someone.</div>}
      {people.map((p) => (
        <PersonSection key={p.id} person={p} />
      ))}
    </>
  );
}

function PersonSection({ person }: { person: Person }) {
  const { view } = useItems();
  const tagged = (view?.items ?? []).filter((i) => person.tagged.includes(i.key));
  return (
    <section className="sec">
      <div className="sec-h">
        <h2>
          {person.name} · {person.role}
        </h2>
        {person.since && <span className="hint">{person.since}</span>}
      </div>
      <div className="cols">
        <PersonCard person={person} />
        <div className="card">
          <h3>Past conversations</h3>
          {person.history.length ? (
            <div className="tl">
              {person.history.map((e, n) => (
                <div key={n} className="ev">
                  <span className="when">{shortDate(e.at)}</span>
                  <span className="ic">{KIND_ICON[e.kind]}</span>
                  <div className="what [overflow-wrap:anywhere]">
                    {e.title}
                    {e.detail && <div className="q">{e.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">Nothing logged yet. Had it on the agenda logs a conversation here.</div>
          )}
        </div>
      </div>
      <div className="cols">
        <div className="card">
          <h3>
            Items tagged {person.name} · {tagged.length}
          </h3>
          <div className="list">
            {tagged.length ? (
              tagged.map((i) => <ItemCard key={i.key} item={i} ctx="area" />)
            ) : (
              <div className="empty">Nothing tagged. Any item&rsquo;s ⋯ menu can send it here.</div>
            )}
          </div>
        </div>
        <Facts person={person} />
      </div>
    </section>
  );
}

/** Facts as label/value pairs; Edit swaps in one "Label: value" per line. */
function Facts({ person }: { person: Person }) {
  const { change } = usePeople();
  const { say } = useItems();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const start = () => {
    setText(person.facts.map(([k, v]) => `${k}: ${v}`).join("\n"));
    setEditing(true);
  };
  const save = async () => {
    const facts = text
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)] as [string, string]);
    const saved = await change({ id: person.id, op: "facts", facts });
    say(saved ? "Facts saved" : "That didn't save");
    if (saved) setEditing(false);
  };

  return (
    <div className="card">
      <div className="sec-h">
        <h3>Facts</h3>
        {!editing && (
          <button className="btn sm ghost" type="button" onClick={start}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="pform">
          <textarea rows={Math.max(4, person.facts.length + 1)} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          <span className="lbl soft">One per line, as Label: value</span>
          <div className="chips">
            <button className="btn sm primary" type="button" onClick={save}>
              Save
            </button>
            <button className="btn sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : person.facts.length ? (
        <dl className="kv">
          {person.facts.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="empty">No facts yet.</div>
      )}
    </div>
  );
}
