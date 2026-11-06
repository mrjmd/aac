import Link from "next/link";

/** System's Health | Automations switch. */
export function SystemTabs({ on }: { on: "health" | "automations" }) {
  return (
    <div className="seg" role="tablist">
      <Link role="tab" href="/health" className={on === "health" ? "on" : ""}>
        Health
      </Link>
      <Link role="tab" href="/health/automations" className={on === "automations" ? "on" : ""}>
        Automations
      </Link>
    </div>
  );
}
