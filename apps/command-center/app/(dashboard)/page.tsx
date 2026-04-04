import { DashboardCard } from "@aac/ui";
import { MiddlewareHealthCard } from "./components/middleware-health-card";
import { TodoCard } from "./components/todo-card";

export default function DashboardPage() {
  return (
    <div>
      {/* Header */}
      <div className="mb-8 rounded-2xl bg-aac-dark p-6">
        <h2 className="font-display text-2xl font-bold text-white">
          Good morning, Matt.
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Here&apos;s your business at a glance.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <MiddlewareHealthCard />

        <TodoCard />

        <DashboardCard
          title="Business Pulse"
          status="gray"
          statusLabel="Coming soon"
        >
          <p className="text-sm text-zinc-400">
            Cash flow, invoices, estimates, and scheduled jobs.
          </p>
        </DashboardCard>

        <DashboardCard
          title="New Leads"
          status="gray"
          statusLabel="Coming soon"
        >
          <p className="text-sm text-zinc-400">
            Recent leads from ads, calls, and referrals.
          </p>
        </DashboardCard>

        <DashboardCard
          title="Website / SEO / Ads"
          status="gray"
          statusLabel="Coming soon"
        >
          <p className="text-sm text-zinc-400">
            Traffic, search rankings, and ad performance.
          </p>
        </DashboardCard>

        <DashboardCard
          title="Marketing Campaigns"
          status="gray"
          statusLabel="Coming soon"
        >
          <p className="text-sm text-zinc-400">
            Active campaigns, response rates, and opt-outs.
          </p>
        </DashboardCard>

        <DashboardCard
          title="Important Dates"
          status="gray"
          statusLabel="Coming soon"
        >
          <p className="text-sm text-zinc-400">
            Renewals, partnerships, and seasonal prep.
          </p>
        </DashboardCard>
      </div>
    </div>
  );
}
