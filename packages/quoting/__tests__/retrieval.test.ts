import { describe, it, expect } from 'vitest';
import { cosineSimilarity, retrieveSimilar } from '../src/retrieval.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-3, 0])).toBeCloseTo(-1);
  });

  it('throws on length mismatch and returns 0 for zero vectors', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow('mismatch');
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('retrieveSimilar', () => {
  const lib = [
    { id: 'a', vector: [1, 0] },
    { id: 'b', vector: [0.9, 0.1] },
    { id: 'c', vector: [0, 1] },
    { id: 'bad', vector: [1, 2, 3] },
  ];

  it('returns top-k highest first, skipping mismatched dimensions', () => {
    const got = retrieveSimilar([1, 0], lib, 2);
    expect(got.map((s) => s.item.id)).toEqual(['a', 'b']);
    expect(got[0].score).toBeGreaterThan(got[1].score);
  });

  it('handles k larger than library and k=0', () => {
    expect(retrieveSimilar([1, 0], lib, 10)).toHaveLength(3);
    expect(retrieveSimilar([1, 0], lib, 0)).toHaveLength(0);
  });
});
