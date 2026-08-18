import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOutcome } from '@/lib/jobs/copy';

/**
 * The generation page used to hard-code "Applied N files successfully!" after
 * startApply, even when apply-ai-code-stream closed with a partial-apply
 * warning. Chat must reuse applyOutcome — one vocabulary for one fact.
 */

const PAGE = readFileSync(join(process.cwd(), 'app/generation/page.tsx'), 'utf8');
const APPLY_JSON = readFileSync(join(process.cwd(), 'app/api/apply-ai-code/route.ts'), 'utf8');

describe('generation page apply copy — source', () => {
  it('does not hard-code a full-success sentence after startApply', () => {
    expect(PAGE).not.toContain('Applied ${results.filesCreated.length} files successfully!');
    expect(PAGE).not.toContain('Code applied successfully!');
    expect(PAGE).not.toContain('Edit applied successfully!');
    expect(PAGE).toContain('applyPageCopy');
  });

  it('keeps the unused JSON apply route on applyOutcome so the sentence cannot drift', () => {
    expect(APPLY_JSON).not.toContain('Applied ${results.filesCreated.length} files successfully');
    expect(APPLY_JSON).toContain('applyOutcome');
  });
});

describe('applyPageCopy reuses applyOutcome counts', () => {
  it('clean apply is still a clean success', async () => {
    const { applyPageCopy } = await import('@/lib/generation/apply-page-copy');
    const input = {
      filesCreated: ['src/App.jsx', 'src/main.jsx'],
      filesUpdated: [] as string[],
      errors: [] as string[],
    };
    expect(applyPageCopy(input)).toEqual(applyOutcome(input));
    expect(applyPageCopy(input).message).toBe('Successfully applied 2 files');
    expect(applyPageCopy(input).warning).toBeNull();
  });

  it('partial apply uses the engine sentence, not a second success line', async () => {
    const { applyPageCopy } = await import('@/lib/generation/apply-page-copy');
    const input = {
      filesCreated: ['src/App.jsx', 'src/Header.jsx'],
      filesUpdated: ['src/main.jsx'],
      errors: ['Failed to create src/Footer.jsx: EACCES', 'Failed to create src/Nav.jsx: timeout'],
    };
    const copy = applyPageCopy(input);
    expect(copy).toEqual(applyOutcome(input));
    expect(copy.message).toBe('3 files were applied. 2 files could not be written — try again');
    expect(copy.message).not.toMatch(/successfully/i);
  });

  it('nothing applied does not claim a successful write', async () => {
    const { applyPageCopy } = await import('@/lib/generation/apply-page-copy');
    const input = {
      filesCreated: [] as string[],
      filesUpdated: [] as string[],
      errors: ['Failed to create src/App.jsx: EACCES', 'Morph apply failed for src/Header.jsx: sandbox gone'],
    };
    const copy = applyPageCopy(input);
    expect(copy).toEqual(applyOutcome(input));
    expect(copy.message).toBe('2 files could not be written — try again');
  });

  it('does not treat a preview or package warning as a failed write', async () => {
    const { applyPageCopy } = await import('@/lib/generation/apply-page-copy');
    const input = {
      filesCreated: ['src/App.jsx'],
      filesUpdated: [] as string[],
      errors: ['The preview did not come back after the restart', 'Package installation failed: npm ERR! 404'],
    };
    expect(applyPageCopy(input)).toEqual({
      message: 'Successfully applied 1 files',
      warning: null,
    });
  });

  it('skips a second chat line when the stream warning already said the same thing', async () => {
    const { shouldAddApplyChat } = await import('@/lib/generation/apply-page-copy');
    const message = '3 files were applied. 2 files could not be written — try again';
    expect(shouldAddApplyChat(message, message)).toBe(false);
    expect(shouldAddApplyChat(undefined, message)).toBe(true);
    expect(shouldAddApplyChat('Code applied successfully!', message)).toBe(true);
  });
});
