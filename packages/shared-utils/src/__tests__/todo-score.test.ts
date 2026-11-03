import { describe, it, expect } from 'vitest';
import { todoScore } from '../types';

describe('todoScore', () => {
  it('scores dated to-dos by due date', () => {
    expect(todoScore('2026-11-10')).toBe(new Date('2026-11-10').getTime());
    expect(todoScore('2026-11-10')).toBeLessThan(todoScore('2026-12-01'));
  });

  it('sorts undated to-dos after every dated one', () => {
    expect(todoScore(null)).toBeGreaterThan(todoScore('2099-12-31'));
  });
});
