"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isRuleActive, type Referral, type StandingRule } from "@aac/quoting/can-help";
import { PageHeader } from "../components/layout-parts";
import { useItems } from "../items-context";

interface Data {
  referrals: Referral[];
  rules: StandingRule[];
}

type Filter = "all" | "ref" | "noref";

function shortDate(day: string, approx = false): string {
  const d = new Date(`${day}T12:00:00Z`);
  // Seeded "since" dates on the 1st are month-level estimates; show them that way.
  if (approx && day.endsWith("-01")) return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const active = isRuleActive;
const ruleLabel = (r: StandingRule) => r.short ?? r.text.split(/[.:(]/)[0]!;

function flash(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("hot");
  setTimeout(() => el.classList.remove("hot"), 1400);
}

/** The approved Referrals mockup: who we send what, the decline and case-by-case rules, time-bound policies. */
export function ReferralsView({ initial, today }: { initial: Data; today: string }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const { say } = useItems();
  const router = useRouter();

  useEffect(() => setData(initial), [initial]);

  const change = async (body: Record<string, unknown>, ok: string): Promise<boolean> => {
    const res = await fetch("/api/referrals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Partial<Data> & { error?: string };
    if (!res.ok || !json.referrals || !json.rules) {
      say(json.error ?? "That didn't save");
      return false;
    }
    setData({ referrals: json.referrals, rules: json.rules });
    say(ok);
    router.refresh();
    return true;
  };

  const byId = new Map(data.referrals.map((r) => [r.id, r]));
  // Newest rules first: the latest owner decisions are the ones to check.
  const declines = data.rules.filter((r) => r.kind === "decline").sort((a, b) => b.since.localeCompare(a.since) || a.id.localeCompare(b.id));
  const caseByCase = data.rules.filter((r) => r.kind === "case-by-case").sort((a, b) => b.since.localeCompare(a.since) || a.id.localeCompare(b.id));
  const policies = data.rules.filter((r) => r.kind === "policy");
  const missing = data.referrals.filter((r) => !r.phone);
  const reviews = policies.filter((p) => p.reviewBy && p.reviewBy <= today && active(p, today));
  const shown = declines.filter((r) => filter === "all" || (filter === "ref" ? r.referralIds?.length : !r.referralIds?.length));
  const usedBy = (id: string) => [...declines, ...caseByCase].filter((r) => r.referralIds?.includes(id));

  const jumpToRule = (id: string) => {
    if (filter !== "all") setFilter("all");
    setTimeout(() => flash(`rule-${id}`), 0);
  };
  const editRef = (id: string) => {
    setEditing(`ref:${id}`);
    setTimeout(() => flash(`ref-${id}`), 0);
  };

  return (
    <div className="refs">
      <PageHeader
        eyebrow="What we send out"
        title="Referrals"
        sub="Who gets the work we don't do, the rules for what we decline, and what you decide case by case. The intake reply and the quote drafter read this page's list every time they draft."
        right={
          <button className="btn primary" type="button" onClick={() => setEditing("ref:new")}>
            + Referral
          </button>
        }
      />

      <div className="glance">
        <div className="gl">
          <span className="micro">Referrals</span>
          <b>{data.referrals.length}</b>
        </div>
        <div className="gl">
          <span className="micro">Decline rules</span>
          <b>{declines.filter((r) => active(r, today)).length}</b>
        </div>
        <div className="gl">
          <span className="micro">Case by case</span>
          <b>{caseByCase.filter((r) => active(r, today)).length}</b>
        </div>
        <div className="gl">
          <span className="micro">Time-bound policies</span>
          <b>{policies.filter((r) => active(r, today)).length}</b>
        </div>
        <div className="gl">
          <span className="micro">Missing a phone</span>
          <b style={missing.length ? { color: "var(--amber)" } : undefined}>{missing.length}</b>
        </div>
      </div>

      {(missing.length > 0 || reviews.length > 0) && (
        <section className="sec">
          <div className="sec-h">
            <h2>Needs you</h2>
            <span className="hint">A referral reply without a number makes the customer look it up.</span>
          </div>
          <div className="list">
            {missing.map((r) => (
              <div key={r.id} className="item amber">
                <div className="row">
                  <div className="body">
                    <div className="title">{r.name} has no phone number</div>
                    <div className="meta">
                      <span className="tag area">Referrals</span>
                      <span className="tag">Used by {usedBy(r.id).length} rules</span>
                    </div>
                  </div>
                  <div className="acts">
                    <button className="btn sm primary" type="button" onClick={() => editRef(r.id)}>
                      Add number
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {reviews.map((p) => (
              <div key={p.id} className="item amber">
                <div className="row">
                  <div className="body">
                    <div className="title">Does &quot;{ruleLabel(p)}&quot; still hold?</div>
                    <div className="meta">
                      <span className="tag area">Policy</span>
                      <span className="tag">Review date {shortDate(p.reviewBy!)}</span>
                    </div>
                  </div>
                  <div className="acts">
                    <button className="btn sm primary" type="button" onClick={() => setEditing(`rule:${p.id}`)}>
                      Review
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="sec">
        <div className="sec-h">
          <h2>Who gets what</h2>
          <span className="hint">Click a rule chip to jump to it below.</span>
        </div>
        <div className="convs">
          {editing === "ref:new" && (
            <ReferralCard ref_={null} rules={[]} editing onEdit={() => {}} onCancel={() => setEditing(null)} onJump={jumpToRule} change={change} />
          )}
          {data.referrals.map((r) => (
            <ReferralCard
              key={r.id}
              ref_={r}
              rules={usedBy(r.id)}
              editing={editing === `ref:${r.id}`}
              onEdit={() => setEditing(`ref:${r.id}`)}
              onCancel={() => setEditing(null)}
              onJump={jumpToRule}
              change={change}
            />
          ))}
        </div>
      </section>

      <section className="sec" id="policies">
        <div className="sec-h">
          <h2>Time-bound policies</h2>
          <span className="hint">Show up on Today when their review date arrives.</span>
        </div>
        <div className="card">
          {policies.length === 0 && <div className="empty">No time-bound policies.</div>}
          {policies.map((p) =>
            editing === `rule:${p.id}` ? (
              <RuleForm key={p.id} rule={p} kind="policy" referrals={data.referrals} onDone={() => setEditing(null)} change={change} />
            ) : (
              <div key={p.id} className={`rule${active(p, today) ? "" : " off"}`} id={`rule-${p.id}`}>
                <div className="n">
                  <div className="t">{p.text}</div>
                  <dl className="kv">
                    <dt>Since</dt>
                    <dd>{shortDate(p.since, true)}</dd>
                    {(p.until || p.untilWhen) && (
                      <>
                        <dt>{p.until && p.until < today ? "Ended" : "Ends"}</dt>
                        <dd>{p.until ? shortDate(p.until) : `When ${p.untilWhen}`}</dd>
                      </>
                    )}
                    {p.reviewBy && active(p, today) && (
                      <>
                        <dt>Review</dt>
                        <dd>
                          {shortDate(p.reviewBy)} <span className="st risk">{p.reviewBy <= today ? "Due now" : "Asks you then"}</span>
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
                <div className="acts">
                  {active(p, today) ? <span className="st on">Active</span> : <span className="st nd">Ended</span>}
                  <button className="btn sm" type="button" onClick={() => setEditing(`rule:${p.id}`)}>
                    Edit
                  </button>
                  {active(p, today) && (
                    <button className="btn sm ghost" type="button" onClick={() => change({ op: "endRule", id: p.id }, `Ended. Drafters stop using it on their next run.`)}>
                      End now
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      </section>

      <section className="sec">
        <div className="sec-h">
          <h2>What we decline</h2>
          <div className="filters">
            {(
              [
                ["all", `All ${declines.length}`],
                ["ref", "With a referral"],
                ["noref", "No referral"],
              ] as const
            ).map(([f, label]) => (
              <button key={f} type="button" className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          {shown.map((r) =>
            editing === `rule:${r.id}` ? (
              <RuleForm key={r.id} rule={r} kind="decline" referrals={data.referrals} onDone={() => setEditing(null)} change={change} />
            ) : (
              <RuleRow key={r.id} rule={r} byId={byId} onEdit={() => setEditing(`rule:${r.id}`)} change={change} />
            ),
          )}
          {editing === "rule:new" && <RuleForm rule={null} kind="decline" referrals={data.referrals} onDone={() => setEditing(null)} change={change} />}
        </div>
        {editing !== "rule:new" && (
          <button className="btn sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setEditing("rule:new")}>
            + Decline rule
          </button>
        )}
      </section>

      <section className="sec">
        <div className="sec-h">
          <h2>Case by case</h2>
          <span className="hint">Never declined automatically. The draft asks what you'd need to decide and flags it for you.</span>
        </div>
        <div className="card">
          {caseByCase.length === 0 && editing !== "rule:new-cbc" && <div className="empty">Nothing case by case.</div>}
          {caseByCase.map((r) =>
            editing === `rule:${r.id}` ? (
              <RuleForm key={r.id} rule={r} kind="case-by-case" referrals={data.referrals} onDone={() => setEditing(null)} change={change} />
            ) : (
              <RuleRow key={r.id} rule={r} byId={byId} onEdit={() => setEditing(`rule:${r.id}`)} change={change} />
            ),
          )}
          {editing === "rule:new-cbc" && <RuleForm rule={null} kind="case-by-case" referrals={data.referrals} onDone={() => setEditing(null)} change={change} />}
        </div>
        {editing !== "rule:new-cbc" && (
          <button className="btn sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setEditing("rule:new-cbc")}>
            + Case-by-case rule
          </button>
        )}
      </section>

      <section className="sec">
        <div className="sec-h">
          <h2>Referral drafts</h2>
          <span className="hint">From the referral listener (not built yet).</span>
        </div>
        <div className="empty">
          When a customer asks for work on this list, the listener drafts a referral text into a Quo note on their conversation. Each draft shows up here with who it pointed them to.
          Nothing is ever sent for you.
        </div>
      </section>
    </div>
  );
}

type Change = (body: Record<string, unknown>, ok: string) => Promise<boolean>;

function RuleRow({ rule: r, byId, onEdit, change }: { rule: StandingRule; byId: Map<string, Referral>; onEdit: () => void; change: Change }) {
  return (
    <div className={`rule${r.paused ? " off" : ""}`} id={`rule-${r.id}`}>
      <div className="n">
        <div className="t">{r.text}</div>
        <div className="meta">
          {r.referralIds?.length ? (
            r.referralIds.map((id) => {
              const ref = byId.get(id);
              if (!ref) return null;
              return (
                <button key={id} type="button" className="tag link" onClick={() => flash(`ref-${id}`)}>
                  → {ref.name}
                  {ref.phone ? "" : " (no phone)"}
                </button>
              );
            })
          ) : (
            <span className="tag">{r.kind === "case-by-case" ? "No referral" : "Decline kindly, no referral"}</span>
          )}
          <span className="tag">Since {shortDate(r.since, true)}</span>
          {r.paused && <span className="tag amber">Paused: drafters ignore it</span>}
        </div>
      </div>
      <div className="acts">
        <button className="btn sm" type="button" onClick={onEdit}>
          Edit
        </button>
        <button
          className="btn sm ghost"
          type="button"
          onClick={() => change({ op: "pauseRule", id: r.id, paused: !r.paused }, r.paused ? "Back on. Drafters use it on their next run." : "Paused. Drafters ignore it until you turn it back on.")}
        >
          {r.paused ? "Turn back on" : "Pause"}
        </button>
      </div>
    </div>
  );
}

function ReferralCard({
  ref_,
  rules,
  editing,
  onEdit,
  onCancel,
  onJump,
  change,
}: {
  ref_: Referral | null;
  rules: StandingRule[];
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onJump: (ruleId: string) => void;
  change: Change;
}) {
  const [name, setName] = useState(ref_?.name ?? "");
  const [phone, setPhone] = useState(ref_?.phone ?? "");
  const [sends, setSends] = useState(ref_?.sends ?? "");
  const [note, setNote] = useState(ref_?.note ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { say } = useItems();

  useEffect(() => {
    if (!editing) return;
    setName(ref_?.name ?? "");
    setPhone(ref_?.phone ?? "");
    setSends(ref_?.sends ?? "");
    setNote(ref_?.note ?? "");
  }, [editing, ref_]);

  const chips = rules.length ? (
    rules.map((x) => (
      <button key={x.id} type="button" className="tag link" onClick={() => onJump(x.id)}>
        {ruleLabel(x)}
      </button>
    ))
  ) : (
    <span className="tag">None yet</span>
  );

  const domId = ref_ ? `ref-${ref_.id}` : "ref-new";
  if (editing) {
    const save = async (e: React.FormEvent) => {
      e.preventDefault();
      const ok = await change(
        { op: "putReferral", ...(ref_ ? { id: ref_.id } : {}), name, phone, sends, note },
        "Saved. Drafters use it on their next run.",
      );
      if (ok) onCancel();
    };
    return (
      <div className="pcard flash" id={domId}>
        <div className="who">
          <b>{ref_?.name ?? "New referral"}</b>
          <span className="micro" style={{ color: "var(--accent)" }}>
            Editing
          </span>
        </div>
        <form className="pform" onSubmit={save}>
          <label>
            Name, as you say it to customers
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Phone
            <input type="text" value={phone} placeholder="(617) 555-0100" onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            What we send them
            <textarea value={sends} onChange={(e) => setSends(e.target.value)} />
          </label>
          <label>
            Private note (never shown to customers)
            <input type="text" value={note} placeholder="e.g. Tanner prefers texts, quick to respond" onChange={(e) => setNote(e.target.value)} />
          </label>
          {ref_ && (
            <>
              <div className="lbl">Decline rules that point here</div>
              <div className="chiprow">{chips}</div>
            </>
          )}
          <div className="a">
            <button className="btn sm primary" type="submit" disabled={!name.trim() || !sends.trim()}>
              Save
            </button>
            <button className="btn sm ghost" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  const r = ref_!;
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v).then(
      () => say(`Copied ${v}`),
      () => say(v),
    );
  };
  return (
    <div className="pcard" id={domId}>
      <div className="who">
        <b>{r.name}</b>
      </div>
      <div className="phone">
        {r.phone ? (
          <>
            <span>{r.phone}</span>
            <button className="btn sm ghost" type="button" onClick={() => copy(r.phone!)}>
              Copy
            </button>
          </>
        ) : (
          <span className="none">No phone on file</span>
        )}
      </div>
      <div className="lbl">We send them</div>
      <div className="sends">{r.sends}</div>
      {r.note && <div className="note">{r.note}</div>}
      <div className="lbl">From these rules</div>
      <div className="chiprow">{chips}</div>
      <div className="a">
        <button className="btn sm" type="button" onClick={onEdit}>
          Edit
        </button>
        {confirmRemove ? (
          <>
            <button className="btn sm primary" type="button" onClick={() => change({ op: "removeReferral", id: r.id }, `${r.name} removed`)}>
              Remove {r.name}?
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="btn sm ghost" type="button" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function RuleForm({
  rule,
  kind,
  referrals,
  onDone,
  change,
}: {
  rule: StandingRule | null;
  kind: StandingRule["kind"];
  referrals: Referral[];
  onDone: () => void;
  change: Change;
}) {
  const [short, setShort] = useState(rule?.short ?? "");
  const [text, setText] = useState(rule?.text ?? "");
  const [refs, setRefs] = useState<string[]>(rule?.referralIds ?? []);
  const [untilWhen, setUntilWhen] = useState(rule?.untilWhen ?? "");
  const [reviewBy, setReviewBy] = useState(rule?.reviewBy ?? "");

  const toggle = (id: string) => setRefs((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await change(
      { op: "putRule", ...(rule ? { id: rule.id } : { kind }), short, text, referralIds: refs, untilWhen, reviewBy },
      "Saved. Drafters use it on their next run.",
    );
    if (ok) onDone();
  };

  return (
    <form className="pform" id={rule ? `rule-${rule.id}` : "rule-new"} onSubmit={save}>
      <div className="two">
        <label>
          Short label
          <input type="text" value={short} placeholder="e.g. Leaking cinder block" onChange={(e) => setShort(e.target.value)} />
        </label>
      </div>
      <label>
        {kind === "policy" ? "The policy, as you'd say it" : kind === "case-by-case" ? "What you decide case by case, as you'd say it" : "What we decline, as you'd say it"}
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {kind === "policy" ? (
        <div className="two">
          <label>
            Ends when
            <input type="text" value={untilWhen} placeholder="tech #2 starts, possibly spring" onChange={(e) => setUntilWhen(e.target.value)} />
          </label>
          <label>
            Ask me again on
            <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} />
          </label>
        </div>
      ) : (
        <>
          <div className="lbl">Refer them to (first is preferred)</div>
          <div className="checks">
            {referrals.map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={refs.includes(r.id)} onChange={() => toggle(r.id)} />
                {r.name}
              </label>
            ))}
          </div>
        </>
      )}
      <div className="chips">
        <button className="btn sm primary" type="submit" disabled={!text.trim()}>
          Save
        </button>
        <button className="btn sm ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
