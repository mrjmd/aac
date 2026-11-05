#!/usr/bin/env npx tsx
/**
 * Upload the quote-drafter assets to Vercel Blob and point the Redis
 * manifest (keys.quoteDrafterAssets) at them. The cloud worker reads the
 * manifest and caches by updatedAt — run this after editing the ruleset,
 * Section V, or regenerating the exemplar library.
 *
 * The local analysis/ files stay the authoritative copies (gitignored
 * business data — that's WHY the worker needs Blob).
 *
 *   npx tsx tools/src/quote-trigger/sync-assets.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { loadEnv, redisFromEnv, requireEnv } from '../lib/env';

const ASSETS: Array<{ field: 'ruleset' | 'sectionV' | 'exemplars'; file: string; required: boolean }> = [
  { field: 'ruleset', file: 'analysis/data/quoting-spike/llm-ruleset.md', required: true },
  { field: 'sectionV', file: 'analysis/data/photo-corpus/section-v-draft-v2.md', required: false },
  { field: 'exemplars', file: 'analysis/data/photo-corpus/exemplar-library-v2.jsonl', required: false },
];

async function main(): Promise<void> {
  loadEnv();
  const token = requireEnv('BLOB_READ_WRITE_TOKEN');
  const redis = redisFromEnv();

  const manifest: Record<string, string> = { updatedAt: new Date().toISOString() };
  for (const asset of ASSETS) {
    if (!fs.existsSync(asset.file)) {
      if (asset.required) throw new Error(`required asset missing: ${asset.file}`);
      console.log(`~ ${asset.field}: ${asset.file} absent — skipped (worker degrades gracefully)`);
      continue;
    }
    const body = fs.readFileSync(asset.file);
    // random suffix = unguessable URL; the manifest in Redis is the only
    // place the URL lives (these files are customer/pricing data).
    const blob = await put(`quote-drafter/${path.basename(asset.file)}`, body, {
      access: 'public',
      token,
      addRandomSuffix: true,
      contentType: 'text/plain; charset=utf-8',
    });
    manifest[asset.field] = blob.url;
    console.log(`✓ ${asset.field}: ${(body.length / 1024).toFixed(0)}KB → ${blob.url.slice(0, 60)}…`);
  }

  await redis.hset(keys.quoteDrafterAssets, manifest);
  console.log(`manifest written to Redis (${keys.quoteDrafterAssets}), updatedAt=${manifest.updatedAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
