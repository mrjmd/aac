#!/usr/bin/env npx tsx
/**
 * Inspect calendar event descriptions for past completed jobs.
 *
 * Applies the same filters as the post-job follow-up cron and dumps
 * each event's description so we can assess whether the free-text
 * description reliably contains the service type.
 *
 * Usage:
 *   npx tsx tools/src/scratch/inspect-followup-descriptions.ts --days 7
 *
 * Credentials are loaded from ../.env.diagnostic (or process.env).
 *
 * Scratch script — exploratory, not production. See tools/CLAUDE.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(): { days: number } {
  const args = process.argv.slice(2);
  let days = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
    }
  }
  return { days };
}

function getDateRange(days: number): { timeMin: string; timeMax: string } {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

  return {
    timeMin: `${startStr}T00:00:00-04:00`,
    timeMax: `${endStr}T23:59:59-04:00`,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const { days } = parseArgs();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN');
  }

  const calendar = new GoogleCalendarClient({
    calendarId: 'matt@attackacrack.com',
    oauth: { clientId, clientSecret, refreshToken },
  });

  const { timeMin, timeMax } = getDateRange(days);
  console.log(`Querying completed jobs from ${timeMin} to ${timeMax}\n`);

  const events = await calendar.listEvents({
    timeMin,
    timeMax,
    attendeeEmails: ['mike@attackacrack.com', 'harrringtonm@gmail.com'],
    colorIds: ['10'],
    requireLocation: true,
    excludeKeywords: ['callback', 'lunch', 'dinner', 'meeting', 'estimate-only', 'consultation-only'],
    minDurationMinutes: 120,
  });

  console.log(`Found ${events.length} completed jobs:\n`);
  console.log('═'.repeat(80));

  for (const event of events) {
    const date = event.start.split('T')[0];
    console.log(`\n[${date}] ${event.summary}`);
    console.log(`Location: ${event.location || '(none)'}`);
    console.log(`Description:`);
    if (event.description) {
      console.log(event.description.split('\n').map((l) => `  ${l}`).join('\n'));
    } else {
      console.log('  (no description)');
    }
    console.log('─'.repeat(80));
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
