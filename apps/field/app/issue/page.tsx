import Link from 'next/link';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { normalizePhone } from '@aac/shared-utils/phone';
import { getCalendar, getPipedrive } from '@/lib/clients';
import { matchEventToPerson } from '@/lib/customer-match';
import { getEasternRangeForDate, getTodayEasternDate, formatEventTime } from '@/lib/dates';
import { classifyEvent } from '@/lib/event-classification';
import { getEnv } from '@/lib/env';
import { getEscalationTarget } from '@/lib/escalation';
import { requireSession } from '@/lib/session';
import RunningLateList, { type UpcomingEvent } from './running-late-list';

export const dynamic = 'force-dynamic';

export default async function IssuePage() {
  const session = await requireSession();
  const env = getEnv();
  const escalation = getEscalationTarget(session);

  // Today's tech-shaped events that haven't ended yet, each paired with the
  // PD-resolved customer phone. Customer match can be slow on cold cache —
  // do it in parallel.
  const today = getTodayEasternDate();
  const { timeMin, timeMax } = getEasternRangeForDate(today);
  const allEvents = await getCalendar()
    .listEvents({ timeMin, timeMax, attendeeEmails: env.technicianEmails })
    .catch((err) => {
      console.error('issue: failed to list events', err);
      return [] as Awaited<ReturnType<ReturnType<typeof getCalendar>['listEvents']>>;
    });

  const now = Date.now();
  const candidates = allEvents
    .filter((e) => classifyEvent(e.colorId) !== 'other')
    .filter((e) => new Date(e.end).getTime() > now)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const pd = getPipedrive();
  const upcoming: UpcomingEvent[] = await Promise.all(
    candidates.map(async (evt): Promise<UpcomingEvent> => {
      let customerPhone: string | null = null;
      try {
        const person = await matchEventToPerson(evt, pd);
        const raw = person ? PipedriveClient.getPrimaryPhone(person) : null;
        customerPhone = raw ? normalizePhone(raw) : null;
      } catch (err) {
        console.error('issue: PD lookup failed', evt.id, err);
      }
      return {
        id: evt.id,
        summary: evt.summary || '(untitled)',
        startLabel: formatEventTime(evt.start),
        customerPhone,
      };
    }),
  );

  return (
    <main className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-aac-blue/20 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Link
            href="/"
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-aac-blue/30 text-lg leading-none text-aac-blue active:bg-aac-blue/5"
          >
            ‹
          </Link>
          <h1 className="font-display text-lg font-bold tracking-tight text-aac-dark">
            Report an issue
          </h1>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-4 py-6 space-y-8">
        <div>
          <h2 className="mb-1 font-display text-base font-bold text-aac-dark">
            Today&apos;s upcoming jobs
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            Call or text the customer directly, or text them that you&apos;re running behind.
          </p>
          <RunningLateList events={upcoming} />
        </div>

        <div>
          <h2 className="mb-3 font-display text-base font-bold text-aac-dark">
            Other issue
          </h2>
          <p className="mb-3 text-sm text-zinc-600">
            Scope change, can&apos;t get access, or something else — get {escalation.name} on it.
          </p>
          <div className="flex gap-2">
            <a
              href={`tel:${escalation.phoneE164}`}
              className="flex-1 rounded-lg bg-aac-blue px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-white shadow-sm active:bg-aac-blue/85"
            >
              Call {escalation.name}
            </a>
            <a
              href={`sms:${escalation.phoneE164}`}
              className="flex-1 rounded-lg border border-aac-blue px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-aac-blue active:bg-aac-blue/5"
            >
              Text {escalation.name}
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-zinc-500">
          Signed in as {session.email}
        </p>
      </section>
    </main>
  );
}
