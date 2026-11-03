import Link from "next/link";
import { notFound } from "next/navigation";
import { buildCustomerTimeline, type TimelineEntry } from "@aac/customers";
import { nyDate } from "@aac/items";
import { EVENT_CLASS_COLOR_IDS, HOLD_TITLE_PREFIX, STUB_TITLE_PREFIX } from "@aac/scheduling";
import { cn } from "@aac/ui";
import { cards, loadSafe } from "@/lib/cards";
import { Freshness } from "../../components/freshness";

export const dynamic = "force-dynamic";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const dateOnly = iso.endsWith("T12:00:00.000Z");
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}

function visitLabel(e: TimelineEntry): string {
  if (e.title.startsWith(HOLD_TITLE_PREFIX)) return "Hold (offered)";
  if (e.title.startsWith(STUB_TITLE_PREFIX)) return "Booked (stub)";
  switch (e.visit?.colorId) {
    case EVENT_CLASS_COLOR_IDS.job:
      return "Job";
    case EVENT_CLASS_COLOR_IDS.assessment:
      return "Assessment";
    case EVENT_CLASS_COLOR_IDS.callback:
      return "Callback";
    default:
      return "Calendar";
  }
}

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  quote: "Quote",
  invoice: "Invoice",
  payment: "Payment",
  text: "Text",
  call: "Call",
  email: "Email",
  visit: "Visit",
};

const STATUS_STYLE: Record<string, string> = {
  Pending: "bg-amber-50 text-amber-700",
  Accepted: "bg-emerald-50 text-emerald-700",
  Closed: "bg-zinc-100 text-zinc-500",
  Rejected: "bg-zinc-100 text-zinc-500",
  paid: "bg-emerald-50 text-emerald-700",
  open: "bg-amber-50 text-amber-700",
  overdue: "bg-red-50 text-red-700",
};

function Entry({ e, upcoming }: { e: TimelineEntry; upcoming: boolean }) {
  const label = e.kind === "visit" ? visitLabel(e) : KIND_LABEL[e.kind];
  const statusText = e.kind === "quote" || e.kind === "invoice" ? e.status : undefined;
  return (
    <div className={cn("px-4 py-3", upcoming && "bg-aac-blue/5")}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm text-aac-dark [overflow-wrap:anywhere]">
          <span
            className={cn(
              "block text-xs font-semibold uppercase tracking-wide sm:mr-2 sm:inline-block sm:w-20",
              e.direction === "in" ? "text-aac-blue" : "text-zinc-400",
            )}
          >
            {label}
          </span>
          {e.href ? (
            <a href={e.href} target="_blank" rel="noreferrer" className="font-medium hover:text-aac-blue hover:underline">
              {e.title}
            </a>
          ) : (
            <span className="font-medium">{e.title}</span>
          )}
          {statusText && (
            <span className={cn("ml-2 rounded px-1.5 py-0.5 text-xs font-medium", STATUS_STYLE[statusText] ?? "bg-zinc-100 text-zinc-500")}>
              {statusText}
            </span>
          )}
          {e.visit?.matchedBy === "name" && (
            <span className="ml-2 text-xs text-zinc-400" title="Matched on the name in the event title only">
              name match
            </span>
          )}
        </p>
        <div className="shrink-0 text-right">
          {e.amount !== undefined && <p className="text-sm font-bold tabular-nums text-aac-dark">{money(e.amount)}</p>}
          <p className="text-xs text-zinc-400">{fmtWhen(e.at)}</p>
        </div>
      </div>
      {e.detail && <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-zinc-500 [overflow-wrap:anywhere] sm:pl-[5.5rem]">{e.detail}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("font-display mt-1 text-lg font-bold", tone === "bad" ? "text-red-700" : "text-aac-dark")}>{value}</p>
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
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-2xl font-bold text-aac-dark">Customer</h1>
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Couldn&apos;t reach QuickBooks: {qbo.error}
        </p>
      </div>
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
    today: nyDate(new Date()),
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

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-xs">
        <Link href="/customers" className="text-zinc-400 hover:text-aac-blue">
          ← Customers
        </Link>
      </p>
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-aac-dark">
          {profile.name}
          {!profile.active && <span className="ml-2 text-sm font-normal text-zinc-400">inactive</span>}
        </h1>
        {profile.company && <p className="text-sm text-zinc-500">{profile.company}</p>}
        <p className="mt-1 text-xs text-zinc-500">
          {[...profile.phones, ...profile.emails, profile.address].filter(Boolean).join(" · ") ||
            "No contact details in QuickBooks"}
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          QuickBooks customer {profile.id}
          {t.lastContact && ` · last contact ${fmtWhen(t.lastContact.at)}`}
          {t.nextVisit && ` · next visit ${fmtWhen(t.nextVisit.at)}`}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1">
        {sources.map((s) => (
          <Freshness key={s.card.name} name={s.card.name} fetchedAt={s.r.snap?.fetchedAt} label={s.label} />
        ))}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Open quotes" value={money(totals.openQuotes)} />
        <Stat label="Accepted" value={money(totals.acceptedQuotes)} />
        <Stat label="Paid" value={money(totals.paid)} />
        <Stat
          label={totals.overdueBalance > 0 ? "Owed (overdue)" : "Owed"}
          value={money(totals.openBalance)}
          tone={totals.overdueBalance > 0 ? "bad" : undefined}
        />
      </div>

      {failed.length > 0 && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Missing from this timeline: {failed.map((s) => `${s.label} (${s.r.error})`).join("; ")}
        </p>
      )}

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">Timeline</h2>
        {t.entries.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing on file yet.</p>
        ) : (
          <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
            {t.entries.map((e) => (
              <Entry key={e.id} e={e} upcoming={e.at > now} />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-zinc-400">
          Texts and calls are the main business line only. Calendar visits match on address or phone; &ldquo;name match&rdquo; means only the
          name in the event title matched.
        </p>
      </section>
    </div>
  );
}
