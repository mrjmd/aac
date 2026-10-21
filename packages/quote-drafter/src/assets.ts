/**
 * Drafting assets live in Vercel Blob (they're business data — `analysis/`
 * is gitignored, and the exemplar library is ~28MB). A Redis manifest
 * points at the current blob URLs; tools/src/quote-trigger/sync-assets.ts
 * writes it, this loader reads it and caches per lambda instance keyed on
 * the manifest's updatedAt.
 */
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import type { ExemplarLibraryEntry } from '@aac/quoting';
import type { DrafterAssets } from './types.js';

export interface AssetManifest {
  ruleset?: string;
  sectionV?: string;
  exemplars?: string;
  updatedAt?: string;
}

let cache: { updatedAt: string; assets: DrafterAssets } | null = null;

async function fetchText(url: string, label: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset fetch failed (${label}): HTTP ${res.status}`);
  return res.text();
}

/**
 * Load the current assets. Returns null when no manifest exists (worker
 * must not draft without the pricing ruleset). sectionV / exemplars are
 * optional — their absence degrades to v1 drafting, same as the CLI.
 */
export async function loadAssets(redis: Redis): Promise<DrafterAssets | null> {
  const manifest = (await redis.hgetall(keys.quoteDrafterAssets)) as AssetManifest | null;
  if (!manifest?.ruleset) return null;
  const version = manifest.updatedAt ?? 'unversioned';
  if (cache && cache.updatedAt === version) return cache.assets;

  const rulesetText = await fetchText(manifest.ruleset, 'ruleset');
  let sectionVText: string | undefined;
  if (manifest.sectionV) {
    sectionVText = await fetchText(manifest.sectionV, 'sectionV').catch(() => undefined);
  }
  let exemplarLibrary: ExemplarLibraryEntry[] = [];
  if (manifest.exemplars) {
    try {
      const jsonl = await fetchText(manifest.exemplars, 'exemplars');
      exemplarLibrary = jsonl
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ExemplarLibraryEntry);
    } catch {
      exemplarLibrary = [];
    }
  }

  const assets: DrafterAssets = { rulesetText, sectionVText, exemplarLibrary };
  cache = { updatedAt: version, assets };
  return assets;
}

/** Test hook. */
export function clearAssetCache(): void {
  cache = null;
}
