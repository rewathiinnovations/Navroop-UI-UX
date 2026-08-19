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
