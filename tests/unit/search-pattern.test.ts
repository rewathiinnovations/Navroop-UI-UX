import { describe, expect, it } from 'vitest';
import {
  filterSearchPatterns,
  unsafeSearchPatternReason,
  MAX_SEARCH_PATTERN_LENGTH,
  MAX_SEARCH_PATTERNS,
} from '@/lib/generation/search-pattern';

/**
 * Model-written regexes are bounded before they leave the edit planner. A
 * catastrophically backtracking pattern runs synchronously and cannot be
 * interrupted, so one would block every request the process is serving (F-752).
 * These prove the pathological shapes and the length cap are refused, and that a
 * refusal is reported rather than swallowed.
 */
describe('unsafeSearchPatternReason', () => {
  it('accepts the ordinary structural patterns a plan actually needs', () => {
    expect(unsafeSearchPatternReason('className=["\'].*header.*["\']')).toBeNull();
    expect(unsafeSearchPatternReason('<header')).toBeNull();
    expect(unsafeSearchPatternReason('(Header|Nav|navbar)')).toBeNull();
    expect(unsafeSearchPatternReason('data-testid="[a-z-]+"')).toBeNull();
  });

  it('refuses a nested quantifier — the classic exponential backtracker', () => {
    expect(unsafeSearchPatternReason('(a+)+$')).toMatch(/exponential/);
    expect(unsafeSearchPatternReason('(\\w+\\s?)*$')).toMatch(/exponential/);
    expect(unsafeSearchPatternReason('(a*)*')).toMatch(/exponential/);
  });

  it('refuses stacked quantifiers', () => {
    expect(unsafeSearchPatternReason('a++')).toMatch(/stacks/);
    expect(unsafeSearchPatternReason('.*+')).toMatch(/stacks/);
  });

  it('refuses an unbounded repeat count', () => {
    expect(unsafeSearchPatternReason('a{9999}')).toMatch(/repeats more than/);
    expect(unsafeSearchPatternReason('(ab){0,5000}')).toMatch(/repeats more than/);
  });

  it('refuses a pattern longer than the cap', () => {
    const long = `${'a'.repeat(MAX_SEARCH_PATTERN_LENGTH + 1)}`;
    expect(unsafeSearchPatternReason(long)).toMatch(/longer than/);
  });

  it('refuses an invalid regex and a non-string', () => {
    expect(unsafeSearchPatternReason('(unclosed')).toMatch(/not a valid/);
    expect(unsafeSearchPatternReason('')).toMatch(/empty/);
    expect(unsafeSearchPatternReason(undefined)).toMatch(/empty/);
    expect(unsafeSearchPatternReason(123)).toMatch(/empty/);
  });

  it('does not mistake a quantified group that cannot repeat for the exponential shape', () => {
    // `(a+)?` and `(a+)` are linear: the group is not itself repeated.
    expect(unsafeSearchPatternReason('(a+)?')).toBeNull();
    expect(unsafeSearchPatternReason('(a+)')).toBeNull();
  });

  it('reads escaped and character-class metacharacters as literals', () => {
    // `\(a+\)+` is a literal paren, not a group, so it is not the nested shape;
    // `[(+]` is a class, not a quantifier stack.
    expect(unsafeSearchPatternReason('\\(a+\\)+')).toBeNull();
    expect(unsafeSearchPatternReason('[(+*]')).toBeNull();
  });
});

describe('filterSearchPatterns', () => {
  it('keeps the safe patterns and reports each refusal by name', () => {
    const result = filterSearchPatterns(['<header', '(a+)+$', 'data-id']);
    expect(result.safe).toEqual(['<header', 'data-id']);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].pattern).toBe('(a+)+$');
    expect(result.refused[0].reason).toMatch(/exponential/);
  });

  it('caps the number of patterns, refusing the overflow', () => {
    const many = Array.from({ length: MAX_SEARCH_PATTERNS + 3 }, (_, i) => `term${i}`);
    const result = filterSearchPatterns(many);
    expect(result.safe).toHaveLength(MAX_SEARCH_PATTERNS);
    expect(result.refused).toHaveLength(3);
    expect(result.refused.every((row) => /exceeds the/.test(row.reason))).toBe(true);
  });

  it('treats an absent list as no patterns', () => {
    expect(filterSearchPatterns(undefined)).toEqual({ safe: [], refused: [] });
  });

  it('a refused pathological pattern never reaches the safe set that a consumer would compile', () => {
    const result = filterSearchPatterns(['(x+)+y']);
    expect(result.safe).toEqual([]);
    // Nothing downstream can compile it, so the event loop cannot be stalled.
    expect(() => result.safe.forEach((p) => new RegExp(p))).not.toThrow();
  });
});
