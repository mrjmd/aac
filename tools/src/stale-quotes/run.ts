#!/usr/bin/env npx tsx
/**
 * Stale-quote follow-up, run by hand from the laptop. The scan itself lives
 * in @aac/stale-quotes (the worker's daily /api/stale-quotes runs the same
 * thing); state, queue and awaiting-reply list are in Redis.
 *
 * Usage (repo root):
 *   npx tsx tools/src/stale-quotes/run.ts --dry-run          # print, write nothing (refreshes the awaiting-reply list)
 *   npx tsx tools/src/stale-quotes/run.ts                    # live: notes + queue + state
 *   npx tsx tools/src/stale-quotes/run.ts --doc 1516         # one estimate
 *   npx tsx tools/src/stale-quotes/run.ts --max-drafts 4     # cap this run (default 6)
 *
 * A live run takes the same Redis run lock as the worker's cron
 * (keys.staleQuotesRunLock), so the two never overlap: if the cron holds
 * it, this exits; while this holds it, the cron skips with "locked". The
 * lock is renewed while the run lasts and released at the end.
 */

import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GmailClient } from '@aac/api-clients/gmail';
import { RedisStaleQuoteStore, runStaleQuotes, MAX_DRAFTS_PER_RUN, type RunResult } from '@aac/stale-quotes';
import { technicianEmails } from '@aac/shared-utils/calendar';
import { keys } from '@aac/shared-utils/redis';
import { geminiFromEnv, googleOAuthFromEnv, loadEnv, quickBooksFromEnv, quoFromEnv, redisFromEnv } from '../lib/env';

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const doc = argv.includes('--doc') ? argv[argv.indexOf('--doc') + 1] : undefined;
  const maxDrafts = argv.includes('--max-drafts') ? Number(argv[argv.indexOf('--max-drafts') + 1]) : MAX_DRAFTS_PER_RUN;

  const redis = redisFromEnv();
  const oauth = googleOAuthFromEnv();

  // Same lock and TTL as apps/worker/api/stale-quotes.ts. Dry runs write only
  // the awaiting list, so they don't need it.
  const LOCK_TTL_S = 900;
  const lockValue = `manual:${Date.now()}`;
  let renew: ReturnType<typeof setInterval> | undefined;
  if (!dryRun) {
    if (!(await redis.set(keys.staleQuotesRunLock, lockValue, { nx: true, ex: LOCK_TTL_S }))) {
      console.error('A stale-quote run is already in progress (worker cron or another manual run). Try again later.');
      process.exitCode = 1;
      return;
    }
    renew = setInterval(() => void redis.expire(keys.staleQuotesRunLock, LOCK_TTL_S), 60_000);
  }
  let r: RunResult;
  try {
    r = await runStaleQuotes(
      {
        qb: quickBooksFromEnv(redis),
        quo: quoFromEnv(),
        gemini: geminiFromEnv(),
        calendar: new GoogleCalendarClient({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com', oauth }),
        gmail: new GmailClient({ oauth }),
        store: new RedisStaleQuoteStore(redis),
        techEmails: technicianEmails(process.env.TECHNICIAN_EMAILS),
        log: (line) => console.log(line),
      },
      { dryRun, doc, maxDrafts },
    );
  } finally {
    if (renew) clearInterval(renew);
    if (!dryRun && (await redis.get<string>(keys.staleQuotesRunLock)) === lockValue) {
      await redis.del(keys.staleQuotesRunLock);
    }
  }

  const { queue, awaiting } = r;
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`booking horizon: ${r.horizon}`);
  console.log(`drafts to send: ${queue.toSend.length}`);
  for (const d of queue.toSend) console.log(`  [${d.tier}/${d.variant}] #${d.doc} ${d.customer} ${d.phone} $${d.amount.toLocaleString()}`);
  console.log(`still waiting (queued earlier, unsent): ${queue.waiting.length}`);
  for (const d of queue.waiting) console.log(`  [${d.tier}] #${d.doc} ${d.customer} queued ${d.queuedAt.slice(0, 10)}`);
  console.log(`flags: ${queue.flags.length}`);
  for (const f of queue.flags) console.log(`  [${f.kind}] #${f.doc} ${f.customer} $${f.amount.toLocaleString()} — ${f.detail}`);
  console.log(`awaiting your reply (customer spoke last): ${awaiting.length} ($${awaiting.reduce((s, a) => s + a.amount, 0).toLocaleString()})`);
  console.log(`skipped: ${queue.skipped.length}`);
  const byReason = new Map<string, number>();
  for (const s of queue.skipped) byReason.set(s.reason.split(' ')[0], (byReason.get(s.reason.split(' ')[0]) ?? 0) + 1);
  for (const [reason, n] of byReason) console.log(`  ${n}× ${reason}`);
}

main().catch((err) => {
  console.error('stale-quote followup failed:', err);
  process.exit(1);
});
