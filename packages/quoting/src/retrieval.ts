/**
 * retrieval — in-process cosine retrieval over the exemplar library
 * (Phase 3 of docs/projects/photo-quote-training.md).
 *
 * The corpus is small (hundreds of area exemplars), so retrieval is a
 * precomputed-embeddings JSONL + brute-force cosine — no vector DB. Vectors
 * come from GeminiClient.embedContent; stored vectors are only comparable
 * to queries embedded with the SAME model.
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`vector length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Top-k most similar library entries for a query vector, highest first.
 * Entries with mismatched vector dimensions are skipped (a re-embedded
 * library mixing models should fail loudly elsewhere, not crash retrieval).
 */
export function retrieveSimilar<T extends { vector: number[] }>(
  query: number[],
  library: T[],
  k: number,
): Array<Scored<T>> {
  const scored: Array<Scored<T>> = [];
  for (const item of library) {
    if (item.vector.length !== query.length) continue;
    scored.push({ item, score: cosineSimilarity(query, item.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
