/**
 * Anchored source slicing for the source-scan tests.
 *
 * Several suites assert on the *text* of a large route handler, because the branch
 * they pin is inline in a 1,900-line function and there is no seam to import. The
 * usual shape was:
 *
 * ```ts
 * source.slice(source.indexOf('let backendFiles = {};'), source.indexOf('let hasBackendFiles ='))
 * ```
 *
 * which has a specific and quiet failure mode (F-682). `String.indexOf` returns `-1`
 * for a missing anchor, and `slice(start, -1)` does not throw — it means "up to the
 * last character". So when a refactor moved one anchor, the slice silently widened
 * from a 40-line block to the entire remainder of the file, and a `not.toMatch`
 * assertion that had been checking "this block does not consult `isEdit`" started
 * reading nine unrelated `isEdit` uses further down. The test failed, but it reported
 * a logic regression in the route rather than a rotted anchor in itself. The inverse
 * is worse and was the real risk: a `toMatch` assertion keeps passing on the widened
 * slice, so the test goes vacuous and nothing says so.
 *
 * Verified 2026-08-21: changing `let hasBackendFiles =` to `const hasBackendFiles =`
 * in the generate route (a `prefer-const` fix, F-790) reproduced exactly that, and
 * `tsc` could not have caught it — `tsconfig.json` excludes `tests`.
 *
 * These helpers make a missing or out-of-order anchor a loud, self-describing failure
 * instead. Prefer them over a bare `indexOf` pair in any new source-scan test.
 */

/** Thrown when an anchor is missing or the pair is out of order. */
export class AnchorError extends Error {}

function describeAnchor(anchor: string) {
  return anchor.length > 60 ? `${anchor.slice(0, 57)}...` : anchor;
}

/**
 * Index of `anchor` in `source`, or a thrown `AnchorError` naming it.
 *
 * Use when a test needs the position itself; use `sliceBetween` when it needs the
 * text between two anchors.
 */
export function requireAnchor(source: string, anchor: string, label = 'anchor'): number {
  const index = source.indexOf(anchor);
  if (index === -1) {
    throw new AnchorError(
      `${label} not found: ${describeAnchor(anchor)}\n` +
        'The source moved under this test. Re-point the anchor at the construct it ' +
        'means to pin — do not widen it until it matches.',
    );
  }
  return index;
}

/**
 * The text from the start of `startAnchor` to the start of `endAnchor`.
 *
 * Throws unless both anchors are present and `startAnchor` precedes `endAnchor`, so
 * the slice can never silently become "the rest of the file".
 */
export function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = requireAnchor(source, startAnchor, 'start anchor');
  const end = requireAnchor(source, endAnchor, 'end anchor');
  if (end <= start) {
    throw new AnchorError(
      `anchors are out of order: ${describeAnchor(startAnchor)} resolves to ${start}, ` +
        `${describeAnchor(endAnchor)} to ${end}. The slice would be empty, and every ` +
        '`expect(...).not.toMatch(...)` over it would pass for the wrong reason.',
    );
  }
  return source.slice(start, end);
}

/** `sliceBetween`, with `//` and block comments stripped so a scan reads code only. */
export function codeBetween(source: string, startAnchor: string, endAnchor: string): string {
  return sliceBetween(source, startAnchor, endAnchor)
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
