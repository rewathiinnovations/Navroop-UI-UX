import { describe, expect, it } from 'vitest';

import { AnchorError, codeBetween, requireAnchor, sliceBetween } from '../setup/source-slice';

/**
 * F-682. The general form of the trap: `String.indexOf` returns `-1` for a missing
 * anchor and `slice(start, -1)` is legal, so a rotted anchor silently widens the
 * slice to the rest of the file instead of failing. A `not.toMatch` assertion then
 * fails for the wrong reason, and — the case that matters — a `toMatch` assertion
 * keeps passing while checking nothing it was written to check.
 */

const SOURCE = [
  'const before = 1;',
  'function target() {',
  '  const inside = readRow();',
  '  return inside;',
  '}',
  'const after = 2;',
].join('\n');

describe('sliceBetween refuses a slice it cannot prove', () => {
  it('returns the text between two present anchors', () => {
    const block = sliceBetween(SOURCE, 'function target() {', 'const after');
    expect(block).toContain('readRow()');
    expect(block).not.toContain('const after');
    expect(block).not.toContain('const before');
  });

  it('throws instead of widening to the rest of the file when the end anchor is gone', () => {
    // The exact regression: `let hasBackendFiles =` became `const hasBackendFiles =`.
    expect(() => sliceBetween(SOURCE, 'function target() {', 'let after')).toThrow(AnchorError);
    expect(() => sliceBetween(SOURCE, 'function target() {', 'let after')).toThrow(
      /end anchor not found/,
    );
  });

  it('throws when the start anchor is gone rather than slicing from zero', () => {
    expect(() => sliceBetween(SOURCE, 'let target() {', 'const after')).toThrow(
      /start anchor not found/,
    );
  });

  it('throws when the anchors are reversed, which would give an empty vacuous slice', () => {
    expect(() => sliceBetween(SOURCE, 'const after', 'function target() {')).toThrow(
      /out of order/,
    );
  });

  it('is the behaviour a bare indexOf pair does not have', () => {
    // Proof the trap is real and not hypothetical: this is what the old shape did.
    const naive = SOURCE.slice(SOURCE.indexOf('function target() {'), SOURCE.indexOf('let after'));
    expect(SOURCE.indexOf('let after')).toBe(-1);
    expect(naive).toContain('const after'); // Swallowed the rest of the file.
  });
});

describe('requireAnchor names the anchor it could not find', () => {
  it('returns the index when present', () => {
    expect(requireAnchor(SOURCE, 'function target() {')).toBe(
      SOURCE.indexOf('function target() {'),
    );
  });

  it('throws with the anchor text in the message', () => {
    expect(() => requireAnchor(SOURCE, 'function missing() {')).toThrow(/function missing\(\) \{/);
  });
});

describe('codeBetween strips comments so a scan reads code only', () => {
  const commented = [
    'function target() {',
    '  // mentions isEdit but does not consult it',
    '  /* nor does this block comment */',
    '  return row;',
    '}',
    'const after = 2;',
  ].join('\n');

  it('drops line and block comments', () => {
    const block = codeBetween(commented, 'function target() {', 'const after');
    expect(block).not.toContain('isEdit');
    expect(block).not.toContain('block comment');
    expect(block).toContain('return row;');
  });

  it('still refuses a missing anchor', () => {
    expect(() => codeBetween(commented, 'function target() {', 'let after')).toThrow(AnchorError);
  });
});
