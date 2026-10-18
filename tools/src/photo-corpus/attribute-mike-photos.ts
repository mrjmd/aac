#!/usr/bin/env npx tsx
/**
 * Attribute Mike's thread photos to corpus estimates.
 *
 * Signals, strongest first (flag-don't-guess policy, same as harvest.ts):
 *   1. VISIT: photo timestamp inside the debrief window of a calendar visit
 *      already matched to the estimate (field-context.jsonl events).
 *   2. MENTION: a Matt↔Mike message within ±15 min of the photo mentions
 *      the customer's last name (first name counts only with a same-window
 *      visit).
 * A photo matching multiple estimates is recorded on each with
 * ambiguousWith set — downstream passes must not treat those as certain.
 *
 * Output: mike-photo-attribution.jsonl {estimateId, docNumber, photos[]}
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = 'analysis/data/photo-corpus';
const OUT_PATH = path.join(OUT_DIR, 'mike-photo-attribution.jsonl');
const DAY = 86_400_000;
// Photos are sent from the site or that evening — a tight window keeps
// same-day visits to OTHER customers from cross-attributing (texts/calls
// get the wider window in field-context.ts; this script is photos only).
const DEBRIEF_BEFORE_MS = 2 * 60 * 60 * 1000; // 2h before event start
const DEBRIEF_AFTER_MS = 12 * 60 * 60 * 1000; // 12h after
const MENTION_ADJ_MS = 15 * 60 * 1000;

function readJsonl(file: string): any[] {
  const p = path.join(OUT_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function nameTokens(customerName: string): { last: string[]; first: string[] } {
  const words = String(customerName).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  if (words.length <= 1) return { last: words, first: [] };
  return { last: [words[words.length - 1]], first: words.slice(0, -1) };
}

function main(): void {
  const manifest = readJsonl('manifest.jsonl');
  const fieldCtx = new Map(readJsonl('field-context.jsonl').map((r) => [r.estimateId, r]));
  // field-context events are date-only; recover real start times from the
  // calendar sweep so the tight photo window is meaningful.
  const eventStartById = new Map<string, number>(
    readJsonl('calendar-events.jsonl').map((e) => {
      const s = e.start?.dateTime ?? e.start?.date ?? e.start;
      return [e.id, new Date(typeof s === 'string' ? s : '').getTime()];
    }),
  );
  const photos = readJsonl('mike-photos-index.jsonl')
    .filter((p) => p.direction === 'incoming'); // Mike's photos, not Matt's
  const thread = readJsonl('mike-thread.jsonl');

  // thread messages with text, time-indexed for adjacency lookups
  const textMsgs = thread
    .filter((m) => (m.text ?? '').trim())
    .map((m) => ({ at: new Date(m.createdAt).getTime(), text: String(m.text).toLowerCase() }))
    .sort((a, b) => a.at - b.at);

  type Hit = { file: string; at: string; via: 'visit' | 'mention' | 'visit+mention'; withText?: string };
  // candidate pass: every (photo, estimate) pair with its distance to the
  // nearest matched visit (Infinity = mention-only). Nearest visit wins the
  // photo (same nearest-wins policy as harvest attribution); runners-up
  // within AMBIGUITY_MS keep an ambiguous claim, the rest drop.
  const AMBIGUITY_MS = 2 * 60 * 60 * 1000;
  type Candidate = { estimateId: string; hit: Hit; dist: number };
  const candidatesByPhoto = new Map<string, Candidate[]>();

  for (const est of manifest) {
    const ctx = fieldCtx.get(est.estimateId);
    const t = new Date(est.txnDate + 'T12:00:00Z').getTime();
    const lo = t - 45 * DAY;
    const hi = t + 3 * DAY;
    const { last, first } = nameTokens(est.customerName ?? '');
    if (!last.length) continue;

    const visitWindows: Array<[number, number]> = (ctx?.events ?? []).map((e: any) => {
      const v = eventStartById.get(e.id) ?? new Date(e.at + 'T12:00:00Z').getTime();
      return [v - DEBRIEF_BEFORE_MS, v + DEBRIEF_AFTER_MS] as [number, number];
    });

    for (const p of photos) {
      const x = new Date(p.at).getTime();
      if (!(x >= lo && x <= hi)) continue;
      const inVisit = visitWindows.some(([a, b]) => x >= a && x <= b);
      const nearby = textMsgs.filter((m) => Math.abs(m.at - x) <= MENTION_ADJ_MS);
      const hasMention = nearby.some((m) =>
        last.some((tok) => m.text.includes(tok)) ||
        (inVisit && first.some((tok) => m.text.includes(tok))));
      const caption = String(p.withText ?? '').toLowerCase();
      const captionMention = last.some((tok) => caption.includes(tok));

      if (!inVisit && !hasMention && !captionMention) continue;
      const via: Hit['via'] = inVisit && (hasMention || captionMention) ? 'visit+mention' : inVisit ? 'visit' : 'mention';
      const dist = inVisit
        ? Math.min(...visitWindows.map(([a]) => Math.abs(x - (a + DEBRIEF_BEFORE_MS))))
        : Infinity;
      const cands = candidatesByPhoto.get(p.file) ?? [];
      cands.push({ estimateId: est.estimateId, dist, hit: { file: p.file, at: p.at, via, withText: p.withText } });
      candidatesByPhoto.set(p.file, cands);
    }
  }

  // nearest-wins resolution
  const perEstimate = new Map<string, Array<Hit & { ambiguousWith: string[] }>>();
  let totalAttributed = 0;
  let ambiguousCount = 0;
  let droppedClaims = 0;
  for (const cands of candidatesByPhoto.values()) {
    cands.sort((a, b) => a.dist - b.dist);
    const winner = cands[0];
    const contenders = cands.filter(
      (c) => c !== winner && (c.dist - winner.dist <= AMBIGUITY_MS || (winner.dist === Infinity && c.dist === Infinity)),
    );
    droppedClaims += cands.length - 1 - contenders.length;
    const keep = [winner, ...contenders];
    for (const c of keep) {
      const others = keep.filter((k) => k !== c).map((k) => k.estimateId);
      if (others.length) ambiguousCount++;
      const hits = perEstimate.get(c.estimateId) ?? [];
      hits.push({ ...c.hit, ambiguousWith: others });
      perEstimate.set(c.estimateId, hits);
      totalAttributed++;
    }
  }

  const out: string[] = [];
  for (const est of manifest) {
    const rows = perEstimate.get(est.estimateId);
    if (!rows?.length) continue;
    out.push(JSON.stringify({
      estimateId: est.estimateId,
      docNumber: est.docNumber,
      customerName: est.customerName,
      photos: rows,
    }));
  }
  fs.writeFileSync(OUT_PATH, out.join('\n') + '\n');

  const strong = [...perEstimate.values()].flat().filter((h) => h.via !== 'mention').length;
  console.log(`estimates with Mike photos: ${out.length}`);
  console.log(`photo-attributions: ${totalAttributed} (${strong} visit-anchored, ${ambiguousCount} still ambiguous, ${droppedClaims} far claims dropped by nearest-wins)`);
  console.log(`unattributed Mike photos: ${photos.length - candidatesByPhoto.size} of ${photos.length}`);
}

main();
