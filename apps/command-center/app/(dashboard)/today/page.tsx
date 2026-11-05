import { easternDate } from "@aac/shared-utils/eastern";
import { cards, loadSafe } from "@/lib/cards";
import { bookedAhead, fieldDay, techOut } from "@/lib/field-events";
import { usdK } from "../components/layout-parts";
import { TodayView } from "./today-view";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const today = easternDate(new Date());
  const [cash, weeks, cal] = await Promise.all([
    loadSafe(cards.cash()),
    loadSafe(cards.techWeeks()),
    loadSafe(cards.calendarIndex()),
  ]);
  const c = cash.snap?.data;
  const b = weeks.snap ? bookedAhead(weeks.snap.data, today) : null;
  const glance: Array<[string, string]> = [
    ["Cash (Relay)", c ? usdK(c.relayTotal) : "?"],
    ["Booked out", b ? `${b.full} of ${b.of} wks` : "?"],
    ["Owed to us", c ? usdK(c.ar.openTotal) : "?"],
    ["Undeposited", c ? usdK(c.undeposited) : "?"],
  ];
  return (
    <TodayView
      today={today}
      glance={glance}
      jobs={cal.snap ? fieldDay(cal.snap.data, today) : []}
      techOut={cal.snap ? techOut(cal.snap.data, today) : false}
    />
  );
}
