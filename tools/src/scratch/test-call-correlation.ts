#!/usr/bin/env npx tsx
/**
 * GA4 ↔ Pipedrive Call Correlation Test
 *
 * Validates whether GA4 phone_call_click events can be reliably correlated
 * with actual calls logged in Pipedrive (created by Quo webhooks).
 *
 * Tests correlation at multiple time windows (1m, 3m, 5m, 10m, 30m, 60m)
 * and reports match rates and false positive estimates.
 *
 * Usage:
 *   npx tsx tools/src/scratch/test-call-correlation.ts --days 14
 *   npx tsx tools/src/scratch/test-call-correlation.ts --start 2026-03-15 --end 2026-04-01
 *
 * Credentials are loaded from sibling repos:
 *   - Google OAuth2: aac-astro/scripts/.credentials/google-oauth.json + google-token.json
 *   - Pipedrive: aac-slim/.env (PIPEDRIVE_API_KEY, PIPEDRIVE_COMPANY_DOMAIN)
 *
 * Override with env vars if needed:
 *   PIPEDRIVE_API_KEY, PIPEDRIVE_COMPANY_DOMAIN, GA4_PROPERTY_ID
 *
 * Scratch script — exploratory, not production. See tools/CLAUDE.md.
 */

import fs from 'fs';
import path from 'path';
import { GoogleAnalyticsClient } from '@aac/api-clients/google-analytics';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

// ── Config ───────────────────────────────────────────────────────────

// AAC's main business line (MA) — the only Quo number on the website
const AAC_MA_LINE = '+16176681677';
// Edward's sales line — must be excluded from correlation
const EDWARDS_LINE = '+13392175091';

const TIME_WINDOWS_MINUTES = [1, 3, 5, 10, 30, 60];

// ── CLI Args ─────────────────────────────────────────────────────────

function parseArgs(): { startDate: string; endDate: string } {
  const args = process.argv.slice(2);
  let days = 14;
  let startDate: string | null = null;
  let endDate: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--start' && args[i + 1]) {
      startDate = args[i + 1];
      i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      endDate = args[i + 1];
      i++;
    }
  }

  if (startDate && endDate) {
    return { startDate, endDate };
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

// ── Credential Helpers ───────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ASTRO_ROOT = path.resolve(REPO_ROOT, '../aac-astro');
const SLIM_ROOT = path.resolve(REPO_ROOT, '../aac-slim');

function loadGoogleOAuth(): { clientId: string; clientSecret: string; refreshToken: string } {
  const oauthPath = path.join(ASTRO_ROOT, 'scripts/.credentials/google-oauth.json');
  const tokenPath = path.join(ASTRO_ROOT, 'scripts/.credentials/google-token.json');

  if (!fs.existsSync(oauthPath) || !fs.existsSync(tokenPath)) {
    console.error(`Google OAuth credentials not found at ${oauthPath}`);
    console.error('These are the same credentials used by aac-astro reporting scripts.');
    process.exit(1);
  }

  const oauth = JSON.parse(fs.readFileSync(oauthPath, 'utf-8'));
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  return {
    clientId: oauth.installed.client_id,
    clientSecret: oauth.installed.client_secret,
    refreshToken: token.refresh_token,
  };
}

function loadSlimEnv(): Record<string, string> {
  const envPath = path.join(SLIM_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    console.error(`aac-slim .env not found at ${envPath}`);
    process.exit(1);
  }

  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function getEnvOrSlim(key: string, slimEnv: Record<string, string>): string {
  const value = process.env[key] || slimEnv[key];
  if (!value) {
    console.error(`Missing ${key} — not in process.env or aac-slim/.env`);
    process.exit(1);
  }
  return value;
}

// ── Data Types ───────────────────────────────────────────────────────

interface GA4ClickEvent {
  timestamp: Date;
  dateHourMinute: string;   // raw GA4 value
  phoneRegion: string;      // 'CT' or 'MA'
  pagePath: string;
  eventCount: number;
  eventType: 'call' | 'text';
}

interface PipedriveActivity_ {
  activityId: number;
  timestamp: Date;
  subject: string;
  personId: number;
  personName: string;
  personPhone: string | null;
  duration: string;
  note: string | null;
  isMainLine: boolean;      // true if from main business line (not Edward's etc.)
  activityType: 'call' | 'sms';
}

interface CorrelationMatch {
  ga4Click: GA4ClickEvent;
  pipedriveActivity: PipedriveActivity_;
  timeDiffMinutes: number;
}

// ── GA4 Query ────────────────────────────────────────────────────────

async function fetchGA4Clicks(
  ga4: GoogleAnalyticsClient,
  startDate: string,
  endDate: string
): Promise<GA4ClickEvent[]> {
  console.log('\n📊 Querying GA4 for phone_call_click and text_message_click events...');

  const CONVERSION_EVENTS = ['phone_call_click', 'text_message_click'];

  // Try dateHourMinute first — this gives us minute-level granularity
  let usedMinuteGranularity = false;

  try {
    const response = await ga4.runReport({
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'dateHourMinute' },
        { name: 'eventName' },
        { name: 'customEvent:phone_region' },
        { name: 'pagePath' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: CONVERSION_EVENTS },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'dateHourMinute' }, desc: false }],
      limit: 10000,
    });

    const rows = ga4.parseRows(response);
    if (rows.length > 0) {
      usedMinuteGranularity = true;
      console.log(`   dateHourMinute dimension available — minute-level correlation possible`);
      return rows.map((row) => ({
        timestamp: parseDateHourMinute(String(row.dateHourMinute)),
        dateHourMinute: String(row.dateHourMinute),
        phoneRegion: String(row['customEvent:phone_region'] || 'unknown'),
        pagePath: String(row.pagePath),
        eventCount: Number(row.eventCount),
        eventType: String(row.eventName) === 'text_message_click' ? 'text' as const : 'call' as const,
      }));
    }
  } catch {
    console.log(`   dateHourMinute query failed, falling back to dateHour`);
  }

  // Fallback to dateHour
  if (!usedMinuteGranularity) {
    const response = await ga4.runReport({
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'dateHour' },
        { name: 'eventName' },
        { name: 'customEvent:phone_region' },
        { name: 'pagePath' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: CONVERSION_EVENTS },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'dateHour' }, desc: false }],
      limit: 10000,
    });

    const rows = ga4.parseRows(response);
    console.log(`   Using dateHour only — sub-60-minute windows are meaningless`);
    console.log(`   KEY FINDING: minute-level custom dimension needed for viable correlation`);

    return rows.map((row) => ({
      timestamp: parseDateHour(String(row.dateHour)),
      dateHourMinute: String(row.dateHour),
      phoneRegion: String(row['customEvent:phone_region'] || 'unknown'),
      pagePath: String(row.pagePath),
      eventCount: Number(row.eventCount),
      eventType: String(row.eventName) === 'text_message_click' ? 'text' as const : 'call' as const,
    }));
  }

  return [];
}

/**
 * GA4 dateHourMinute is in the GA4 property's reporting timezone.
 *
 * HISTORY:
 * - Before 2026-04-02: Property was set to US Pacific (UTC-7 PDT / UTC-8 PST).
 *   Confirmed by manual verification: GA4 8:48 Pacific = 11:48 Eastern = actual call time.
 * - After 2026-04-02: Property changed to US Eastern (UTC-4 EDT / UTC-5 EST).
 *
 * For historical data (before April 2), use offset 7 (PDT).
 * For new data (April 2+), use offset 4 (EDT).
 *
 * Pipedrive add_time is UTC. Pipedrive timestamps are call END time (not start).
 */
const GA4_TO_UTC_HOURS = 7; // PDT (UTC-7) for data before 2026-04-02. Use 4 for post-April data.

function parseDateHourMinute(dhm: string): Date {
  // Format: YYYYMMDDHHMM (e.g., 202604011430) in GA4 property timezone (Pacific)
  const year = parseInt(dhm.slice(0, 4), 10);
  const month = parseInt(dhm.slice(4, 6), 10) - 1;
  const day = parseInt(dhm.slice(6, 8), 10);
  const hour = parseInt(dhm.slice(8, 10), 10);
  const minute = parseInt(dhm.slice(10, 12), 10);
  // Convert Pacific → UTC by adding the offset
  return new Date(Date.UTC(year, month, day, hour + GA4_TO_UTC_HOURS, minute));
}

function parseDateHour(dh: string): Date {
  // Format: YYYYMMDDHH (e.g., 2026040114) in GA4 property timezone (Pacific)
  const year = parseInt(dh.slice(0, 4), 10);
  const month = parseInt(dh.slice(4, 6), 10) - 1;
  const day = parseInt(dh.slice(6, 8), 10);
  const hour = parseInt(dh.slice(8, 10), 10);
  return new Date(Date.UTC(year, month, day, hour + GA4_TO_UTC_HOURS, 30));
}

// ── Pipedrive Query ──────────────────────────────────────────────────

async function processActivity(
  activity: Awaited<ReturnType<PipedriveClient['listActivities']>>[number],
  activityType: 'call' | 'sms',
  pd: PipedriveClient,
  personCache: Map<number, PipedrivePerson | null>,
  results: PipedriveActivity_[]
): Promise<void> {
  let person = personCache.get(activity.person_id);
  if (person === undefined) {
    person = await pd.getPerson(activity.person_id);
    personCache.set(activity.person_id, person);
  }

  const personPhone = person ? PipedriveClient.getPrimaryPhone(person) : null;

  const note = activity.note || '';
  const isMainLine = !note.includes(EDWARDS_LINE) &&
    !note.includes('339-217-5091') &&
    !note.includes('3392175091');

  results.push({
    activityId: activity.id,
    // Pipedrive add_time is UTC but lacks timezone indicator — append Z
    timestamp: new Date(activity.add_time.replace(' ', 'T') + 'Z'),
    subject: activity.subject,
    personId: activity.person_id,
    personName: person?.name || 'Unknown',
    personPhone,
    duration: activity.duration,
    note: activity.note,
    isMainLine,
    activityType,
  });
}

async function fetchPipedriveActivities(
  pd: PipedriveClient,
  startDate: string,
  endDate: string
): Promise<PipedriveActivity_[]> {
  console.log('\n📞 Querying Pipedrive for call and SMS activities...');

  const results: PipedriveActivity_[] = [];
  const personCache = new Map<number, PipedrivePerson | null>();

  // Fetch call activities (standard Pipedrive type)
  let start = 0;
  const limit = 500;

  while (true) {
    const activities = await pd.listActivities({
      type: 'call',
      startDate,
      endDate,
      done: true,
      limit,
      start,
    });

    if (!activities || activities.length === 0) break;

    for (const activity of activities) {
      await processActivity(activity, 'call', pd, personCache, results);
    }

    if (activities.length < limit) break;
    start += limit;
  }

  // Fetch ALL activities (no type filter) and extract SMS ones
  // Pipedrive doesn't support filtering by custom activity types like 'sms'
  start = 0;
  while (true) {
    const activities = await pd.listActivities({
      startDate,
      endDate,
      done: true,
      limit,
      start,
    });

    if (!activities || activities.length === 0) break;

    for (const activity of activities) {
      // Only process SMS activities we haven't already seen (skip calls)
      if (activity.type === 'sms') {
        await processActivity(activity, 'sms', pd, personCache, results);
      }
    }

    if (activities.length < limit) break;
    start += limit;
  }

  return results;
}

// ── Correlation Engine ───────────────────────────────────────────────

function correlate(
  clicks: GA4ClickEvent[],
  activities: PipedriveActivity_[],
  windowMinutes: number,
  eventType: 'call' | 'text'
): { matches: CorrelationMatch[]; unmatchedClicks: GA4ClickEvent[]; unmatchedActivities: PipedriveActivity_[] } {
  const matches: CorrelationMatch[] = [];
  const matchedClickIndices = new Set<number>();
  const matchedActivityIndices = new Set<number>();

  // Only correlate MA clicks (the only line on the website in Quo)
  const relevantClicks = clicks.filter(
    (c) => c.eventType === eventType && (c.phoneRegion === 'MA' || c.phoneRegion === 'unknown')
  );
  // Filter by subject pattern — Pipedrive stores all as type 'call',
  // so we distinguish by subject prefix instead of activity type
  const relevantActivities = activities.filter((a) => {
    if (!a.isMainLine) return false;
    if (eventType === 'call') {
      return a.subject.startsWith('Inbound Call') || a.subject.startsWith('Outbound Call');
    } else {
      return a.subject.startsWith('SMS Received') || a.subject.startsWith('SMS Sent');
    }
  });

  for (let ci = 0; ci < relevantClicks.length; ci++) {
    const click = relevantClicks[ci];
    let bestMatch: { actIdx: number; timeDiff: number } | null = null;

    for (let ai = 0; ai < relevantActivities.length; ai++) {
      if (matchedActivityIndices.has(ai)) continue;

      const activity = relevantActivities[ai];
      const timeDiffMs = activity.timestamp.getTime() - click.timestamp.getTime();
      const timeDiffMinutes = timeDiffMs / 60000;

      // Activity must happen AFTER click, within the window
      if (timeDiffMinutes >= 0 && timeDiffMinutes <= windowMinutes) {
        if (!bestMatch || timeDiffMinutes < bestMatch.timeDiff) {
          bestMatch = { actIdx: ai, timeDiff: timeDiffMinutes };
        }
      }
    }

    if (bestMatch) {
      matches.push({
        ga4Click: click,
        pipedriveActivity: relevantActivities[bestMatch.actIdx],
        timeDiffMinutes: bestMatch.timeDiff,
      });
      matchedClickIndices.add(ci);
      matchedActivityIndices.add(bestMatch.actIdx);
    }
  }

  const unmatchedClicks = relevantClicks.filter((_, i) => !matchedClickIndices.has(i));
  const unmatchedActivities = relevantActivities.filter((_, i) => !matchedActivityIndices.has(i));

  return { matches, unmatchedClicks, unmatchedActivities };
}

// ── Output ───────────────────────────────────────────────────────────

function printCorrelationTable(
  label: string,
  clicks: GA4ClickEvent[],
  activities: PipedriveActivity_[],
  eventType: 'call' | 'text'
): void {
  const relevantClicks = clicks.filter(
    (c) => c.eventType === eventType && (c.phoneRegion === 'MA' || c.phoneRegion === 'unknown')
  );
  const pdType = eventType === 'call' ? 'call' : 'sms';
  const relevantActivities = activities.filter((a) => {
    if (!a.isMainLine) return false;
    if (eventType === 'call') {
      return a.subject.startsWith('Inbound Call') || a.subject.startsWith('Outbound Call');
    } else {
      return a.subject.startsWith('SMS Received') || a.subject.startsWith('SMS Sent');
    }
  });

  console.log(`\n  ${label}`);
  console.log(`  GA4 ${eventType} clicks (MA): ${relevantClicks.length}  |  Pipedrive ${pdType} activities: ${relevantActivities.length}`);
  console.log('  ' + '-'.repeat(66));
  console.log('  Window  | Matches | Unmatched | Unmatched  | Match  |');
  console.log('          |         | Clicks    | Activities | Rate   |');
  console.log('  ' + '-'.repeat(66));

  for (const window of TIME_WINDOWS_MINUTES) {
    const { matches, unmatchedClicks, unmatchedActivities } = correlate(clicks, activities, window, eventType);
    const matchRate = relevantClicks.length > 0
      ? ((matches.length / relevantClicks.length) * 100).toFixed(1)
      : '0.0';

    console.log(
      `  ${String(window).padStart(3)}m    | ${String(matches.length).padStart(7)} | ${String(unmatchedClicks.length).padStart(9)} | ${String(unmatchedActivities.length).padStart(10)} | ${matchRate.padStart(5)}% |`
    );
  }

  console.log('  ' + '-'.repeat(66));

  // Show detail at 5-minute window
  const bestWindow = 5;
  const { matches, unmatchedClicks, unmatchedActivities } = correlate(clicks, activities, bestWindow, eventType);

  if (matches.length > 0) {
    console.log(`\n  MATCHES AT ${bestWindow}-MINUTE WINDOW (${matches.length} total):`);
    for (const match of matches.slice(0, 10)) {
      const clickTime = match.ga4Click.timestamp.toLocaleString();
      const actTime = match.pipedriveActivity.timestamp.toLocaleString();
      console.log(`    Click: ${clickTime} on ${match.ga4Click.pagePath}`);
      console.log(`    ${label.split(' ')[0]}:  ${actTime} — ${match.pipedriveActivity.subject}`);
      console.log(`           Person: ${match.pipedriveActivity.personName} (${match.pipedriveActivity.personPhone || 'no phone'})`);
      console.log(`           Time diff: ${match.timeDiffMinutes.toFixed(1)} minutes`);
      console.log('');
    }
    if (matches.length > 10) {
      console.log(`    ... and ${matches.length - 10} more matches`);
    }
  }

  if (unmatchedActivities.length > 0) {
    console.log(`\n  UNMATCHED ${pdType.toUpperCase()} ACTIVITIES (${unmatchedActivities.length} — no preceding website click):`);
    for (const act of unmatchedActivities.slice(0, 5)) {
      console.log(`    ${act.timestamp.toLocaleString()} — ${act.subject} — ${act.personName}`);
    }
    if (unmatchedActivities.length > 5) {
      console.log(`    ... and ${unmatchedActivities.length - 5} more`);
    }
  }

  if (unmatchedClicks.length > 0) {
    console.log(`\n  UNMATCHED ${eventType.toUpperCase()} CLICKS (${unmatchedClicks.length} — click but no ${pdType} within ${bestWindow}m):`);
    for (const click of unmatchedClicks.slice(0, 5)) {
      console.log(`    ${click.timestamp.toLocaleString()} on ${click.pagePath} (region: ${click.phoneRegion})`);
    }
    if (unmatchedClicks.length > 5) {
      console.log(`    ... and ${unmatchedClicks.length - 5} more`);
    }
  }
}

function printResults(
  clicks: GA4ClickEvent[],
  activities: PipedriveActivity_[],
  startDate: string,
  endDate: string
): void {
  const callClicks = clicks.filter((c) => c.eventType === 'call');
  const textClicks = clicks.filter((c) => c.eventType === 'text');
  const ctClicks = clicks.filter((c) => c.phoneRegion === 'CT');
  const mainLineActivities = activities.filter((a) => a.isMainLine);
  const otherActivities = activities.filter((a) => !a.isMainLine);

  console.log('\n' + '='.repeat(70));
  console.log('  GA4 ↔ PIPEDRIVE CORRELATION TEST');
  console.log('='.repeat(70));
  console.log(`  Date range: ${startDate} to ${endDate}`);
  console.log('');
  console.log('  RAW DATA:');
  console.log(`    GA4 conversion events:           ${clicks.length} total`);
  console.log(`      phone_call_click:              ${callClicks.length}`);
  console.log(`      text_message_click:            ${textClicks.length}`);
  console.log(`      CT region (no Quo line):        ${ctClicks.length} (cannot correlate)`);
  console.log(`    Pipedrive activities:             ${activities.length} total`);
  console.log(`      Main business line:            ${mainLineActivities.length}`);
  console.log(`      Other lines (excluded):        ${otherActivities.length}`);

  // Phone call correlation
  printCorrelationTable('CALL CORRELATION', clicks, activities, 'call');

  // Text message correlation
  printCorrelationTable('TEXT CORRELATION', clicks, activities, 'text');

  console.log('\n' + '='.repeat(70));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { startDate, endDate } = parseArgs();

  console.log('GA4 ↔ Pipedrive Call Correlation Test');
  console.log(`Date range: ${startDate} to ${endDate}`);

  // Load credentials from sibling repos
  const oauthCreds = loadGoogleOAuth();
  const slimEnv = loadSlimEnv();

  const ga4 = new GoogleAnalyticsClient({
    propertyId: process.env.GA4_PROPERTY_ID || '347942677',
    oauth: oauthCreds,
  });

  const pd = new PipedriveClient({
    apiKey: getEnvOrSlim('PIPEDRIVE_API_KEY', slimEnv),
    companyDomain: getEnvOrSlim('PIPEDRIVE_COMPANY_DOMAIN', slimEnv),
  });

  // Fetch data
  const clicks = await fetchGA4Clicks(ga4, startDate, endDate);
  console.log(`   Found ${clicks.length} conversion events`);

  const activities = await fetchPipedriveActivities(pd, startDate, endDate);
  console.log(`   Found ${activities.length} activities`);

  // Run correlation and print results
  printResults(clicks, activities, startDate, endDate);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
