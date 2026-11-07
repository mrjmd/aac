"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { pendingPeople } from "./components/people";
import { RAIL_AREA, useItems } from "./items-context";
import { usePeople } from "./people-context";

const AREAS = [
  { href: "/sales", key: "sales", label: "Sales" },
  { href: "/jobs", key: "jobs", label: "Jobs" },
  { href: "/money", key: "money", label: "Money" },
  { href: "/marketing", key: "marketing", label: "Marketing" },
  { href: "/admin", key: "admin", label: "Admin" },
  { href: "/commercial", key: "commercial", label: "Commercial" },
] as const;

/** The mockup's area rail: Overview, the areas with open-item counts, then System. Referrals counts contacts missing a phone. */
export function Rail({ referralGaps = 0 }: { referralGaps?: number }) {
  const pathname = usePathname();
  const { view } = useItems();
  const talks = pendingPeople(usePeople().people).length;
  const counts: Record<string, number> = {};
  const reds: Record<string, boolean> = {};
  for (const i of view?.items ?? []) {
    if (i.lane === "confirm") continue;
    const a = RAIL_AREA[i.area];
    counts[a] = (counts[a] ?? 0) + 1;
    if (i.severity === "red") reds[a] = true;
  }
  const todayCount = view?.items.filter((i) => i.band === "today" && i.lane !== "confirm").length ?? 0;
  const overview = ["/today", "/week", "/month"].some((p) => pathname.startsWith(p));

  const link = (href: string, label: string, on: boolean, cnt?: number, tone?: "red" | "amber" | boolean) => (
    <Link key={href} href={href} className={on ? "on" : ""}>
      <span>{label}</span>
      {cnt ? <span className={`count${tone ? ` ${tone === true ? "red" : tone}` : ""}`}>{cnt}</span> : null}
    </Link>
  );

  return (
    <nav className="rail" aria-label="Areas">
      {link("/today", "Overview", overview, todayCount, true)}
      <div className="sep" />
      {AREAS.map((a) => link(a.href, a.label, pathname.startsWith(a.href), counts[a.key], reds[a.key]))}
      <div className="sep" />
      {link("/people", "People", pathname.startsWith("/people"), talks)}
      {link("/customers", "Customers", pathname.startsWith("/customers"))}
      {link("/referrals", "Referrals", pathname.startsWith("/referrals"), referralGaps, "amber")}
      {link("/health", "System", pathname.startsWith("/health"), counts.system, reds.system)}
      {link("/rules", "Rules", pathname.startsWith("/rules"))}
      <div className="sep" />
      <span className="later micro">Customer pages open from any item</span>
    </nav>
  );
}
