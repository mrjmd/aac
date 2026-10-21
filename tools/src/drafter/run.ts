#!/usr/bin/env npx tsx
/**
 * Quote drafter — manual CLI over @aac/quote-drafter (the logic lives in
 * the package; the cloud worker runs the same code on triggers).
 *
 * Usage (from repo root):
 *   npx tsx tools/src/drafter/run.ts              # draft all quote_promised findings
 *   npx tsx tools/src/drafter/run.ts --dry-run    # print drafts, create nothing
 *   npx tsx tools/src/drafter/run.ts --phone +1617...        # one thread only
 *   npx tsx tools/src/drafter/run.ts --phone +1617... --name "Jane Doe"
 *   npx tsx tools/src/drafter/run.ts --phone +1617... --photo-dir /path/to/imgs
 *   npx tsx tools/src/drafter/run.ts --phone +1617... --participants +1617...,+1508...
 *
 * Assets load from the local analysis/ files (the authoritative copies the
 * owner edits); run tools/src/quote-trigger/sync-assets.ts after changing
 * them so the cloud worker picks them up too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { GeminiClient } from '@aac/api-clients/gemini';
import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { GoogleDriveClient } from '@aac/api-clients/google-drive';
import { keys, ttl } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import type { ExemplarLibraryEntry } from '@aac/quoting';
import {
  draftOne,
  loadFieldChannel,
  prepareRun,
  MAX_PHOTOS,
  type DrafterAssets,
  type DrafterDeps,
  type DraftRunRecord,
  type QuoteFinding,
} from '@aac/quote-drafter';

const FINDINGS_PATH = 'analysis/data/triage/findings.json';
const RULESET_PATH = 'analysis/data/quoting-spike/llm-ruleset.md';
const RUNLOG_PATH = 'analysis/data/triage/drafts.json';
const SECTION_V_PATH = 'analysis/data/photo-corpus/section-v-draft-v2.md';
const EXEMPLAR_LIBRARY_PATH = 'analysis/data/photo-corpus/exemplar-library-v2.jsonl';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

interface FindingsFileShape {
  findings: Array<{ section?: string; customer?: string | null; phone?: string | null; title?: string }>;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const dryRun = argv.includes('--dry-run');
  const phoneArg = flag('--phone');
  const nameArg = flag('--name');
  const findingsArg = flag('--findings');
  const skipRecentArg = flag('--skip-if-recent-estimate');
  const photoDirArg = flag('--photo-dir');
  const participantsArg = flag('--participants')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (photoDirArg && !phoneArg) throw new Error('--photo-dir requires --phone (one customer at a time)');
  if (participantsArg && !phoneArg) throw new Error('--participants requires --phone (one customer at a time)');

  // ── targets: explicit phone, else quote_promised findings from triage
  let targets: QuoteFinding[] = [];
  const findingsPath = findingsArg ?? FINDINGS_PATH;
  const findingsFile = fs.existsSync(findingsPath)
    ? (JSON.parse(fs.readFileSync(findingsPath, 'utf8')) as FindingsFileShape)
    : { findings: [] };
  if (phoneArg) {
    const match = findingsFile.findings.find((f) => f.phone === phoneArg);
    targets = [
      {
        phone: phoneArg,
        customer: nameArg ?? match?.customer ?? null,
        title: match?.title ?? `manual run for ${phoneArg}`,
      },
    ];
  } else {
    targets = findingsFile.findings
      .filter((f): f is { section: string; customer: string | null; phone: string; title: string } =>
        !!f.phone && f.section === 'quote_promised',
      )
      .map((f) => ({ phone: f.phone, customer: f.customer ?? null, title: f.title ?? '' }));
    for (const f of findingsFile.findings) {
      if (f.section === 'quote_promised' && !f.phone) {
        console.log(`~ skipping (no phone — email-only thread): ${f.title}`);
      }
    }
  }
  if (targets.length === 0) {
    console.log('No quote_promised findings with a phone number. Nothing to draft.');
    return;
  }
  console.log(`${targets.length} target(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

  // ── assets from the local authoritative files
  const assets: DrafterAssets = {
    rulesetText: fs.readFileSync(RULESET_PATH, 'utf8'),
    sectionVText: fs.existsSync(SECTION_V_PATH) ? fs.readFileSync(SECTION_V_PATH, 'utf8') : undefined,
    exemplarLibrary: fs.existsSync(EXEMPLAR_LIBRARY_PATH)
      ? fs
          .readFileSync(EXEMPLAR_LIBRARY_PATH, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as ExemplarLibraryEntry)
      : [],
  };
  console.log(
    `photo layer: Section V ${assets.sectionVText ? 'loaded' : 'ABSENT'}, exemplar library ${assets.exemplarLibrary.length} areas\n`,
  );

  // ── deps
  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async () =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === 'OK',
      release: async () => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  });
  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });
  const gemini = new GeminiClient({ apiKey: requireEnv('GEMINI_API_KEY'), textModel: 'gemini-3.6-flash' });
  let calendar: GoogleCalendarClient | null = null;
  let drive: GoogleDriveClient | null = null;
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth = {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
    };
    calendar = new GoogleCalendarClient({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'matt@attackacrack.com',
      oauth,
    });
    drive = new GoogleDriveClient({ oauth });
  }
  const deps: DrafterDeps = {
    redis,
    qb,
    quo,
    gemini,
    calendar,
    drive,
    log: (l) => console.log(l),
    now: () => Date.now(),
  };

  // Photos that arrived outside Quo (email, AirDrop) — manual runs only.
  let extraImageParts: Array<{ mimeType: string; base64: string }> | undefined;
  if (photoDirArg) {
    const MIME: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
    };
    extraImageParts = [];
    for (const name of fs.readdirSync(photoDirArg).sort()) {
      if (extraImageParts.length >= MAX_PHOTOS) break;
      const mimeType = MIME[path.extname(name).toLowerCase()];
      if (!mimeType) continue;
      extraImageParts.push({
        mimeType,
        base64: fs.readFileSync(path.join(photoDirArg, name)).toString('base64'),
      });
    }
    console.log(`extra photos: ${extraImageParts.length} loaded from ${photoDirArg}\n`);
  }

  const run = await prepareRun(deps);
  const fieldChannel = await loadFieldChannel(deps);
  const records: DraftRunRecord[] = [];
  for (const finding of targets) {
    console.log(`── ${finding.customer ?? 'unknown'} (${finding.phone}): ${finding.title}`);
    try {
      const record = await draftOne(deps, {
        finding,
        run,
        assets,
        fieldChannel,
        dryRun,
        skipIfRecentEstimateDays: skipRecentArg ? Number(skipRecentArg) : undefined,
        hasNewInbound: true, // manual run = owner override, always allowed to regenerate
        extraImageParts,
        threadParticipants: participantsArg,
      });
      if (record.outcome === 'created') run.nextDocNumber++;
      records.push(record);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      console.log(`  ✗ failed: ${msg}`);
      records.push({ phone: finding.phone, customer: finding.customer ?? '', outcome: 'failed', detail: msg });
    }
    console.log('');
  }

  // Append this run to the local run log (harvest-edits reads it; gitignored).
  const prior = fs.existsSync(RUNLOG_PATH)
    ? (JSON.parse(fs.readFileSync(RUNLOG_PATH, 'utf8')) as unknown[])
    : [];
  prior.push({ ranAt: new Date().toISOString(), dryRun, records });
  fs.mkdirSync(path.dirname(RUNLOG_PATH), { recursive: true });
  fs.writeFileSync(RUNLOG_PATH, JSON.stringify(prior, null, 2));

  const created = records.filter((r) => r.outcome === 'created');
  console.log(
    `Done: ${created.length} created, ${records.filter((r) => r.outcome === 'dry-run').length} dry-run, ${records.filter((r) => r.outcome === 'skipped').length} skipped, ${records.filter((r) => r.outcome === 'failed').length} failed`,
  );
  for (const r of created) {
    console.log(`  → #${r.docNumber} ${r.customer} $${r.total} (estimate ${r.estimateId})`);
  }
}

main().catch((err) => {
  console.error('drafter failed:', err);
  process.exit(1);
});
