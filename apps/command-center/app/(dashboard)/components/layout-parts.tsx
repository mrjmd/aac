import Link from "next/link";

/** The mockup's page header: blue micro eyebrow, display title, muted sub line. */
export function PageHeader({
  eyebrow,
  title,
  sub,
  right,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="ph">
      <div>
        <div className="eyebrow micro">{eyebrow}</div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

const TABS = [
  ["/today", "Today"],
  ["/week", "This week"],
  ["/month", "This month"],
] as const;

export function OverviewTabs({ on }: { on: "/today" | "/week" | "/month" }) {
  return (
    <div className="seg" role="tablist">
      {TABS.map(([href, label]) => (
        <Link key={href} role="tab" href={href} className={on === href ? "on" : ""}>
          {label}
        </Link>
      ))}
    </div>
  );
}

/** A stat tile with the "i" definition popover the mockup puts on every number. */
export function Tile({
  k,
  v,
  s,
  tone,
  def,
}: {
  k: string;
  v: React.ReactNode;
  s?: React.ReactNode;
  tone?: "bad" | "good";
  def?: string;
}) {
  return (
    <div className="tile">
      <div className="k">
        <span>{k}</span>
        {def && (
          <details className="info">
            <summary aria-label="About this number">i</summary>
            <div>{def}</div>
          </details>
        )}
      </div>
      <div className="v num">{v}</div>
      {s && <div className={`s ${tone ?? ""}`}>{s}</div>}
    </div>
  );
}

/** A glance-strip number (top of Today and This week). */
export function Glance({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="gl">
      <span className="micro">{k}</span>
      <b className="num">{v}</b>
    </div>
  );
}

/** A failed source, in the mockup's callout style. */
export function SourceError({ what, error }: { what: string; error: string | null }) {
  return (
    <div className="callout" style={{ borderLeftColor: "var(--red)", background: "var(--red-soft)" }}>
      Couldn&apos;t reach {what}: {error}
    </div>
  );
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const usdK = (n: number) => (Math.abs(n) >= 10_000 ? `$${(n / 1000).toFixed(1)}k` : usd(n));
