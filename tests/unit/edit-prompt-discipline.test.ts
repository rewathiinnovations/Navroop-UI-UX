import { describe, expect, it } from 'vitest';
import { buildVolatilePromptSuffix } from '@/lib/stack-prompts';

/**
 * F-801. The anti-duplicate-file rule and the surgical-edit discipline used to
 * live in `lib/context-selector.ts` / `lib/edit-examples.ts`, which were
 * unreachable dead code (`selectFilesForEdit` was gated on a global with no
 * writer) and were deleted in bce41e5. The instructions were good and the model
 * never received them: the live follow-up prompt was the single line "THIS IS AN
 * EDIT. Change only the files required. Do not regenerate the app."
 *
 * They now live in the volatile suffix, which is the only prompt block that can
 * carry them — they must NOT ship on a first build, where "preserve the existing
 * code" is meaningless.
 */
describe('the follow-up edit block', () => {
  const editSuffix = buildVolatilePromptSuffix({ isEdit: true });

  it('forbids creating a near-duplicate of a file that already exists', () => {
    expect(editSuffix).toMatch(/do not create (a )?new files?/i);
    expect(editSuffix).toMatch(/similar name/i);
  });

  it('names the component-overlap traps that produce duplicates', () => {
    // "add a nav" against a project whose nav lives inside Header is the case
    // that produced a stray Nav.tsx beside the real one.
    expect(editSuffix).toMatch(/nav/i);
    expect(editSuffix).toMatch(/header/i);
  });

  it('carries the surgical discipline, not just "change only the files required"', () => {
    expect(editSuffix).toMatch(/minimal/i);
    expect(editSuffix).toMatch(/refactor/i);
    expect(editSuffix).toMatch(/complete file/i);
  });

  it('constrains a style-only edit to the property named', () => {
    expect(editSuffix).toMatch(/style/i);
  });

  it('still says it is an edit and not to regenerate the app', () => {
    expect(editSuffix).toMatch(/THIS IS AN EDIT/);
    expect(editSuffix).toMatch(/regenerate/i);
  });

  it('ships none of it on a first build', () => {
    const buildSuffix = buildVolatilePromptSuffix({ isEdit: false });
    expect(buildSuffix).toBe('');
    expect(buildVolatilePromptSuffix({ isEdit: false, uiUxBrief: 'brief' })).toBe('brief');
    expect(buildVolatilePromptSuffix({ isEdit: false, uiUxBrief: 'brief' })).not.toMatch(
      /similar name/i,
    );
  });
});
