import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOutcome } from '@/lib/jobs/copy';

/**
 * apply-ai-code-stream used to close with "Successfully applied N files"
 * whenever the write loop finished, even when results.errors listed files
 * that never landed. A preview/package warning is not a failed write — those
 * already have their own frames — so only file-apply failures change the
 * closing sentence.
 */

const APPLY_STREAM = readFileSync(
  join(process.cwd(), 'app/api/apply-ai-code-stream/route.ts'),
  'utf8',
);

describe('applyOutcome — clean apply', () => {
  it('keeps the existing success sentence when every file wrote', () => {
    expect(
      applyOutcome({
        filesCreated: ['src/App.jsx', 'src/main.jsx'],
        filesUpdated: [],
        errors: [],
      }),
    ).toEqual({
      message: 'Successfully applied 2 files',
      warning: null,
    });
  });

  it('does not treat a preview or package warning as a failed write', () => {
    expect(
      applyOutcome({
        filesCreated: ['src/App.jsx'],
        filesUpdated: [],
        errors: [
          'The preview did not come back after the restart',
          'Package installation failed: npm ERR! 404',
        ],
      }),
    ).toEqual({
      message: 'Successfully applied 1 files',
      warning: null,
    });
  });
});

describe('applyOutcome — partial apply', () => {
  it('states how many wrote and how many did not, and asks to try again', () => {
    expect(
      applyOutcome({
        filesCreated: ['src/App.jsx', 'src/Header.jsx'],
        filesUpdated: ['src/main.jsx'],
        errors: [
          'Failed to create src/Footer.jsx: EACCES',
          'Failed to create src/Nav.jsx: timeout',
        ],
      }),
    ).toEqual({
      message: '3 files were applied. 2 files could not be written — try again',
      warning: '3 files were applied. 2 files could not be written — try again',
    });
  });

  it('uses singular nouns when only one file wrote and one failed', () => {
    expect(
      applyOutcome({
        filesCreated: ['src/App.jsx'],
        filesUpdated: [],
        errors: ['Failed to create src/Footer.jsx: disk full'],
      }),
    ).toEqual({
      message: '1 file was applied. 1 file could not be written — try again',
      warning: '1 file was applied. 1 file could not be written — try again',
    });
  });

  it('does not claim any files applied when every write failed', () => {
    expect(
      applyOutcome({
        filesCreated: [],
        filesUpdated: [],
        errors: [
          'Failed to create src/App.jsx: EACCES',
          'Morph apply failed for src/Header.jsx: sandbox gone',
        ],
      }),
    ).toEqual({
      message: '2 files could not be written — try again',
      warning: '2 files could not be written — try again',
    });
  });

  it('counts a Morph apply miss as a file that did not apply', () => {
    const outcome = applyOutcome({
      filesCreated: ['src/App.jsx'],
      filesUpdated: [],
      errors: ['Morph apply exception for src/Hero.jsx: timeout'],
    });
    expect(outcome.warning).toBe('1 file was applied. 1 file could not be written — try again');
  });
});

describe('apply-ai-code-stream uses applyOutcome for the closing sentence', () => {
  it('does not hard-code the old success line', () => {
    expect(APPLY_STREAM).not.toContain(
      'Successfully applied ${results.filesCreated.length} files',
    );
    expect(APPLY_STREAM).toContain('applyOutcome');
    expect(APPLY_STREAM).toContain('if (outcome.warning)');
  });
});
