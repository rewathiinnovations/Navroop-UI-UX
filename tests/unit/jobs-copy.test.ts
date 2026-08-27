import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldCompensatePublish } from '../../lib/jobs/compensate';
import {
  applyOutcome,
  PUBLISH_RECOVERY_HEADING,
  RECOVERY_HEADING,
  recoveryCauseLine,
  recoveryHeading,
} from '../../lib/jobs/copy';

const RECOVERY_PANEL = path.join(process.cwd(), 'components/workspace/RecoveryPanel.tsx');
const PROJECT_WORKSPACE = path.join(process.cwd(), 'components/workspace/ProjectWorkspace.tsx');

describe('jobs recovery / compensate', () => {
  it('first-time publish compensates; re-publish does not', () => {
    expect(shouldCompensatePublish(false)).toBe(true);
    expect(shouldCompensatePublish(true)).toBe(false);
  });

  it('missing cause does not repeat the recovery heading', () => {
    expect(recoveryCauseLine(null)).not.toBe(RECOVERY_HEADING);
  });

  it('an IMPORT failure must not say the build failed', () => {
    expect(recoveryHeading('IMPORT')).toBe('The last import did not finish');
    expect(recoveryHeading('IMPORT').toLowerCase()).not.toMatch(/\bbuild\b/);
  });

  it('names the work that failed for every kind that can reach a recovery panel', () => {
    expect(recoveryHeading('PLAN')).toBe('The last plan did not finish');
    expect(recoveryHeading('BUILD')).toBe('The last build did not finish');
    expect(recoveryHeading('FOLLOWUP')).toBe('The last edit did not finish');
    expect(recoveryHeading('IMPORT')).toBe('The last import did not finish');
    expect(recoveryHeading('PUBLISH')).toBe('Publish did not finish');
    expect(recoveryHeading('PUBLISH')).toBe(PUBLISH_RECOVERY_HEADING);
    expect(recoveryHeading('BUILD')).toBe(RECOVERY_HEADING);
  });

  it('the panel heading is recoveryHeading(kind), not a publish-vs-build special case', () => {
    const source = readFileSync(RECOVERY_PANEL, 'utf8');
    expect(source).toMatch(/recoveryHeading\(/);
    expect(source).not.toMatch(
      /variant === 'publish' \? PUBLISH_RECOVERY_HEADING : RECOVERY_HEADING/,
    );
  });

  it('the chat workspace hides the panel for kinds that are not chat recovery', () => {
    const source = readFileSync(PROJECT_WORKSPACE, 'utf8');
    expect(source).toMatch(/generationJob\.recovery && showsChatRecovery\(/);
  });
});

describe('applyOutcome', () => {
  it('frames a persist-guard rejection as a write miss, never a clean success', () => {
    // F-028: the settle path now refuses oversized / binary / broken-package.json files
    // (lib/generation/write-guard.ts). Those rejections arrive here as errors and must
    // land on the same partial-apply warning the Morph / write failures use.
    expect(
      applyOutcome({
        filesCreated: ['app/page.tsx'],
        errors: ['File is too large: assets/big.css'],
      }),
    ).toEqual({
      message: '1 file was applied. 1 file could not be written — try again',
      warning: '1 file was applied. 1 file could not be written — try again',
    });
    expect(
      applyOutcome({
        filesCreated: [],
        errors: ['Binary content is not allowed: public/logo.png'],
      }).warning,
    ).toBe('1 file could not be written — try again');
    expect(
      applyOutcome({
        filesCreated: ['app/page.tsx'],
        errors: ['package.json is not valid JSON: Unexpected token'],
      }).warning,
    ).not.toBeNull();
    expect(
      applyOutcome({ filesCreated: ['a.ts'], errors: ['Generated output is too large'] }).warning,
    ).not.toBeNull();
    expect(
      applyOutcome({ filesCreated: ['a.ts'], errors: ['Unsafe file path: ../../.env'] }).warning,
    ).not.toBeNull();
  });

  it('keeps preview and package notices out of the file-failure count', () => {
    expect(applyOutcome({ filesCreated: ['a.ts'], errors: ['Preview timed out'] })).toEqual({
      message: 'Successfully applied 1 file',
      warning: null,
    });
  });
});
