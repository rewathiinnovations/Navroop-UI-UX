/**
 * The repair instruction must name the failure class honestly.
 *
 * Live incident: the preview crashed with
 * `Uncaught TypeError: Cannot read properties of undefined (reading 'map')` — code
 * that compiled perfectly. "Fix this" sent "The preview fails to compile with: …",
 * so the model looked for a build error that did not exist, wrote one unrelated
 * file, reported success, and the crash was still there on reload.
 */
import { describe, expect, it } from 'vitest';
import { previewRepairInstruction } from '@/lib/preview/labels';

const CRASH = "Uncaught TypeError: Cannot read properties of undefined (reading 'map')";
const MISSING_EXPORT = 'No matching export in "lib/data.ts" for import "site"';

describe('previewRepairInstruction', () => {
  it('does not claim a compile failure for a page that crashed at runtime', () => {
    const instruction = previewRepairInstruction(CRASH, 'runtime');

    expect(instruction).not.toMatch(/does not compile|fails to compile/i);
    expect(instruction).toContain('compiles, but the page crashes');
    expect(instruction).toContain(CRASH);
  });

  it('points a runtime crash at the data, which is what is actually undefined', () => {
    const instruction = previewRepairInstruction(CRASH, 'runtime');

    expect(instruction).toMatch(/mapped over/i);
    expect(instruction).toMatch(/always defined/i);
  });

  it('states a compile failure plainly', () => {
    const instruction = previewRepairInstruction(MISSING_EXPORT, 'code');

    expect(instruction).toContain('does not compile');
    expect(instruction).toContain(MISSING_EXPORT);
    expect(instruction).not.toMatch(/crashes/i);
  });

  it('always asks for the files back, or nothing is applied', () => {
    // A repair that only explains the bug leaves the site broken: the apply step
    // has nothing to write, which is how one round-trip ended with 0 files.
    for (const kind of ['code', 'runtime'] as const) {
      expect(previewRepairInstruction(CRASH, kind)).toMatch(/Return the corrected files/);
    }
  });

  it('keeps the reported text intact, including a stack riding along with it', () => {
    const withStack = `${CRASH}\n\n    at Gallery (vfs:components/Gallery.tsx:14:22)`;

    expect(previewRepairInstruction(withStack, 'runtime')).toContain('at Gallery');
  });
});

/**
 * Which page crashed.
 *
 * The bridge posted only a message and a stack, so every page of a multi-page
 * site reported its crash identically and a failure on `/pricing` was repaired
 * as though it had happened on the home page. The stack was added because a
 * repair "had nowhere to look"; the route is the other half of that fix, and
 * the preview's own router already knows it.
 */
describe('previewRepairInstruction with a route', () => {
  it('names the page that crashed', () => {
    const instruction = previewRepairInstruction(CRASH, 'runtime', '/pricing');

    expect(instruction).toContain('/pricing');
    expect(instruction).toContain(CRASH);
  });

  it('keeps the runtime framing rather than turning into a compile message', () => {
    const instruction = previewRepairInstruction(CRASH, 'runtime', '/pricing');

    expect(instruction).not.toMatch(/does not compile|fails to compile/i);
    expect(instruction).toMatch(/always defined/i);
  });

  it('reads exactly as before when the frame could not say which page it was', () => {
    expect(previewRepairInstruction(CRASH, 'runtime', undefined)).toBe(
      previewRepairInstruction(CRASH, 'runtime'),
    );
  });

  it('leaves a compile failure alone, where a route means nothing', () => {
    expect(previewRepairInstruction(MISSING_EXPORT, 'code', '/pricing')).toBe(
      previewRepairInstruction(MISSING_EXPORT, 'code'),
    );
  });
});
