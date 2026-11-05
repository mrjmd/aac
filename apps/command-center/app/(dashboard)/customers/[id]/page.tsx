import { notFound } from "next/navigation";
import { buildCustomerTimeline, type TimelineEntry } from "@aac/customers";
import { easternDate } from "@aac/shared-utils/eastern";
import { cards, loadSafe } from "@/lib/cards";
import { FIELD_LABEL, fieldClass } from "@/lib/field-events";
import { Freshness } from "../../components/freshness";
import { PageHeader, SourceError, Tile, usd } from "../../components/layout-parts";

export const dynamic = "force-dynamic";

function fmtWhen(iso: string): string {
  const dateOnly = iso.endsWith("T12:00:00.000Z");
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}

const KIND: Record<TimelineEntry["kind"], [string, string]> = {
  quote: ["Quote", "Q"],
  invoice: ["Invoice", "I"],
  payment: ["Payment", "$"],
  text: ["Text", "T"],
  call: ["Call", "C"],
  email: ["Email", "E"],
  visit: ["Visit", "V"],
};

/** Status pill classes from the mockup (.st on / risk / off / nd). */
const STATUS: Record<string, string> = {
  Pending: "risk",
  Accepted: "on",
  Closed: "nd",
  Rejected: "nd",
  paid: "on",
  open: "risk",
  overdue: "off",
};

function label(e: TimelineEntry): string {
  if (e.kind !== "visit") return KIND[e.kind][0] + (e.direction === "in" ? " in" : e.direction === "out" ? " out" : "");
  const cls = fieldClass({ summary: e.title, colorId: e.visit?.colorId });
  return cls ? FIELD_LABEL[cls] : "Calendar";
}

function Entry({ e, upcoming }: { e: TimelineEntry; upcoming: boolean }) {
  const status = e.kind === "quote" || e.kind === "invoice" ? e.status : undefined;
  return (
    <div className="ev">
      <span className="when">{fmtWhen(e.at)}</span>
      <span className="ic" style={e.direction === "out" ? { background: "var(--ink-2)" } : undefined}>
        {KIND[e.kind][1]}
      </span>
      <div className="what [overflow-wrap:anywhere]">
        {/* Text and call titles already say what they are ("Text from customer"). */}
        {e.title.startsWith(KIND[e.kind][0]) ? null : <b>{label(e)}: </b>}
        {e.href ? (
          <a href={e.href} target="_blank" rel="noreferrer">
            {e.title}
          </a>
        ) : e.title.startsWith(KIND[e.kind][0]) ? (
          <b>{e.title}</b>
        ) : (
          e.title
        )}
        {e.amount !== undefined && <b className="num"> · {usd(e.amount)}</b>}
        {status && (
          <span className={`st ${STATUS[status] ?? "nd"}`} style={{ marginLeft: 6 }}>
            {status}
          </span>
        )}
        {upcoming && <span className="tag ontoday" style={{ marginLeft: 6 }}>Upcoming</span>}
        {e.visit?.matchedBy === "name" && (
          <span className="tag" style={{ marginLeft: 6 }} title="Matched on the name in the event title only">
            Name match
          </span>
        )}
        {e.detail && <div className="q whitespace-pre-line">{e.detail}</div>}
      </div>
    </div>
  );
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const qboCard = cards.customerQbo(id);
  const qbo = await loadSafe(qboCard);
  if (!qbo.snap) {
    return (
      <>
        <PageHeader eyebrow="Customer" title="Customer" />
        <SourceError what="QuickBooks" error={qbo.error} />
      </>
    );
  }
  const part = qbo.snap.data;
  if (!part) notFound();

  const quoCard = cards.customerQuo(id);
  const emailCard = cards.customerEmail(id);
  const calCard = cards.calendarIndex();
  const [quo, email, cal] = await Promise.all([loadSafe(quoCard), loadSafe(emailCard), loadSafe(calCard)]);
  const t = buildCustomerTimeline({
    ...part,
    messages: quo.snap?.data.messages ?? [],
    calls: quo.snap?.data.calls ?? [],
    emails: email.snap?.data ?? [],
    events: cal.snap?.data ?? [],
    today: easternDate(new Date()),
    now: new Date(),
  });
  const sources = [
    { card: qboCard, label: "QuickBooks", r: qbo },
    { card: quoCard, label: "Texts & calls", r: quo },
    { card: emailCard, label: "Email", r: email },
    { card: calCard, label: "Calendar", r: cal },
  ];
  const { profile, totals } = t;
  const now = new Date().toISOString();
  const failed = sources.filter((s) => s.r.error);
  const next = t.nextVisit;

  return (
    <>
      <PageHeader
        eyebrow="Customer"
        title={profile.name}
        sub={
          <span className="num">
            {[profile.company, ...profile.phones, ...profile.emails, profile.address].filter(Boolean).join(" · ") ||
              "No contact details in QuickBooks"}
          </span>
        }
        right={
          <div className="chips">
            {!profile.active && <span className="st nd">Inactive</span>}
            {totals.overdueBalance > 0 && <span className="st off">Overdue {usd(totals.overdueBalance)}</span>}
            {totals.openQuotes > 0 && <span className="st risk">Open quote</span>}
          </div>
        }
      />

      <div className="tiles">
        <Tile k="Open quotes" v={usd(totals.openQuotes)} s={totals.acceptedQuotes ? `${usd(totals.acceptedQuotes)} accepted` : undefined} def="Pending QBO estimates." />
        <Tile k="Lifetime paid" v={usd(totals.paid)} s={totals.paid ? undefined : "No payments yet"} def="QBO payments." />
        <Tile
          k="Owed"
          v={usd(totals.openBalance)}
          s={totals.overdueBalance > 0 ? `${usd(totals.overdueBalance)} overdue` : "Nothing overdue"}
          tone={totals.overdueBalance > 0 ? "bad" : undefined}
          def="Open invoice balances. Source: QBO."
        />
        <Tile
          k="Next visit"
          v={next ? fmtWhen(next.at).replace(/, \d{4}/, "") : "None"}
          s={next ? label(next) : t.lastContact ? `Last contact ${fmtWhen(t.lastContact.at)}` : undefined}
          def="Calendar events matched by address, phone or name."
        />
      </div>

      {failed.length > 0 && (
        <SourceError what={failed.map((s) => s.label).join(", ")} error={failed.map((s) => s.r.error).join("; ")} />
      )}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h3>Timeline</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
            {sources.map((s) => (
              <Freshness key={s.card.name} name={s.card.name} fetchedAt={s.r.snap?.fetchedAt} label={s.label} />
            ))}
          </div>
        </div>
        {t.entries.length === 0 ? (
          <div className="empty">Nothing on file yet.</div>
        ) : (
          <div className="tl">
            {t.entries.map((e) => (
              <Entry key={e.id} e={e} upcoming={e.at > now} />
            ))}
          </div>
        )}
        <div className="note">
          QuickBooks customer {profile.id}. Texts and calls are the main business line only. Calendar visits match on
          address or phone; &ldquo;Name match&rdquo; means only the name in the event title matched.
        </div>
      </div>
    </>
  );
}
