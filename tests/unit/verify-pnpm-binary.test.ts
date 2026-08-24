import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corepackEntry, resolvePnpmCommand } from '@/lib/verify/pnpm-binary';
import { VERIFY_STEPS } from '@/lib/verify/orchestrator';

/**
 * The audit step is the only `VERIFY_STEPS` entry that still shells out to pnpm, and
 * `scripts/verify.ts` spawns with `shell: true`, so the name goes through PATH. On a
 * machine without pnpm there — which `.cursor/rules/single-dev-server.mdc` says is this
 * one — the step failed in 0.0s with "command not found", which in the summary is
 * indistinguishable from an audit that found a high-severity advisory and cannot be
 * fixed by anything in the diff.
 *
 * The rewrite is a fallback and must stay one: a machine with pnpm on PATH has to keep
 * running the plain command, or the gate stops matching what `docs/release.md` tells an
 * operator to type.
 */
describe('the audit step runs even where pnpm is not on PATH', () => {
  const AUDIT = 'pnpm audit --audit-level=high';
  const corepack = () => 'C:/Program Files/nodejs/node_modules/corepack/dist/corepack.js';

  it('leaves the command alone when pnpm resolves', () => {
    expect(resolvePnpmCommand(AUDIT, { hasPnpm: () => true, corepack })).toBe(AUDIT);
  });

  it('routes through corepack when it does not', () => {
    const out = resolvePnpmCommand(AUDIT, {
      hasPnpm: () => false,
      corepack,
      node: 'C:/Program Files/nodejs/node.exe',
    });
    expect(out).toContain('corepack.js');
    // corepack honours `packageManager`, so the fallback runs the pinned pnpm rather
    // than whatever a global install happens to be.
    expect(out).toContain('pnpm audit --audit-level=high');
    expect(out.startsWith('"C:/Program Files/nodejs/node.exe"')).toBe(true);
  });

  it('hands back the original when there is no corepack either', () => {
    // So the failure is pnpm's own "not found", which names the real problem, rather
    // than a corepack path that does not exist and would blame the wrong thing.
    expect(resolvePnpmCommand(AUDIT, { hasPnpm: () => false, corepack: () => null })).toBe(AUDIT);
  });

  it('touches nothing that is not a pnpm invocation', () => {
    for (const command of [
      'node ./node_modules/vitest/vitest.mjs run --coverage',
      'node ./node_modules/knip/bin/knip.js --include files',
      // Not a bare `pnpm …`: the prefix has to be the program, not a substring.
      'echo pnpm audit',
    ]) {
      expect(resolvePnpmCommand(command, { hasPnpm: () => false, corepack })).toBe(command);
    }
  });

  it('covers the one step that needs it, and no more', () => {
    // If a second pnpm call is ever added, this fails and whoever added it decides
    // deliberately whether the fallback should apply to it too.
    const pnpmSteps = VERIFY_STEPS.filter((step) => /^pnpm\s/.test(step.command)).map(
      (step) => step.id,
    );
    expect(pnpmSteps).toEqual(['audit']);
  });

  it('looks for corepack where Node installs it, and reports absence honestly', () => {
    const env = { ProgramFiles: 'C:/PF' } as NodeJS.ProcessEnv;
    // Built with `join` rather than written out: the function uses `path.join`, so the
    // separator is the platform's, and a literal expectation asserts the platform
    // instead of the path.
    expect(corepackEntry(env, () => true)).toBe(
      join('C:/PF', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    );
    expect(corepackEntry(env, () => false)).toBeNull();
  });
});
