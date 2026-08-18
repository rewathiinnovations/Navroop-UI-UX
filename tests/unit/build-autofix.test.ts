import { describe, expect, it } from 'vitest';
import {
  buildErrorSignature,
  checkBuild,
  extractMissingPackages,
  parseBuildErrors,
} from '@/lib/validation/build-check';
import { MAX_AUTOFIX_ATTEMPTS, decideAutoFix } from '@/lib/validation/autofix-policy';
import { buildBuildFixInstruction, filesFromErrors } from '@/lib/validation/fix-prompt';
import type { SandboxRunner } from '@/lib/audit/types';

/**
 * The orphaned lib/build-validator.ts fetched preview HTML and looked for
 * `vite-error-overlay` / `id="root"` — signals only REACT emits, so NEXTJS (the
 * default stack) would pass every broken build. These cover the replacement:
 * run the stack's own build command, and refuse to retry when retrying is futile.
 */

function runner(result: { stdout?: string; stderr?: string; exitCode?: number; success?: boolean }): SandboxRunner {
  return {
    runCommand: async () => ({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
      success: result.success ?? true,
    }),
  };
}

const NEXT_TYPE_ERROR = `
  ▲ Next.js 16.3.1
   Creating an optimized production build ...
Failed to compile.

./app/page.tsx:12:5
Type error: Property 'titel' does not exist on type 'Props'. Did you mean 'title'?
`;

const MISSING_IMPORT = `
Failed to compile.
Module not found: Can't resolve 'framer-motion' in '/home/user/app/components'
`;

describe('checkBuild — stack awareness', () => {
  it('skips STATIC_HTML, which has no build step to fail', async () => {
    const result = await checkBuild({ stack: 'STATIC_HTML', sandbox: runner({}) });
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('no-build-command');
  });

  it('skips rather than fails when there is no sandbox', async () => {
    const result = await checkBuild({ stack: 'NEXTJS', sandbox: null });
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('no-sandbox');
  });

  it('passes a clean NEXTJS build', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      sandbox: runner({ stdout: 'Compiled successfully', exitCode: 0 }),
    });
    expect(result.status).toBe('passed');
    expect(result.signature).toBeNull();
  });

  it('catches a NEXTJS type error — the case the Vite-only validator passed', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      sandbox: runner({ stdout: NEXT_TYPE_ERROR, exitCode: 1, success: false }),
    });
    expect(result.status).toBe('failed');
    expect(result.errors.some((error) => error.file === 'app/page.tsx')).toBe(true);
    expect(result.errors.some((error) => error.kind === 'type')).toBe(true);
  });

  it('treats a sandbox that cannot run commands as unknown, never as a code fault', async () => {
    const broken: SandboxRunner = {
      runCommand: async () => {
        throw new Error('sandbox died');
      },
    };
    const result = await checkBuild({ stack: 'NEXTJS', sandbox: broken });
    expect(result.status).toBe('skipped');
  });

  it('still reports a failure when the exit code is non-zero but nothing parses', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      sandbox: runner({ stdout: 'Failed to compile.', exitCode: 1, success: false }),
    });
    expect(result.status).toBe('failed');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('extractMissingPackages', () => {
  it('pulls the package name out of a Next.js module-not-found', () => {
    expect(extractMissingPackages(MISSING_IMPORT)).toEqual(['framer-motion']);
  });

  it('keeps both segments of a scoped package', () => {
    expect(extractMissingPackages(`Cannot find module '@radix-ui/react-dialog'`)).toEqual([
      '@radix-ui/react-dialog',
    ]);
  });

  it('ignores relative and aliased imports — installing "./Foo" would burn a retry', () => {
    const output = `Cannot find module './Header'\nCannot find module '@/lib/utils'\nCannot find module '/abs'`;
    expect(extractMissingPackages(output)).toEqual([]);
  });
});

describe('parseBuildErrors', () => {
  it('deduplicates the same error repeated across framework layers', () => {
    const repeated = ['Failed to compile.', "Module not found: Can't resolve 'x'", "Module not found: Can't resolve 'x'"].join('\n');
    const messages = parseBuildErrors(repeated).map((error) => error.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('extracts file and line when the compiler names one', () => {
    const [first] = parseBuildErrors('./app/page.tsx:12:5\nType error: bad');
    expect(first.file).toBe('app/page.tsx');
    expect(first.line).toBe(12);
  });
});

describe('buildErrorSignature', () => {
  it('is null when nothing failed', () => {
    expect(buildErrorSignature([])).toBeNull();
  });

  it('ignores line drift so an edit above the fault does not read as progress', () => {
    const a = buildErrorSignature([{ kind: 'type', message: 'Type error: bad', file: 'a.tsx', line: 10 }]);
    const b = buildErrorSignature([{ kind: 'type', message: 'Type error: bad', file: 'a.tsx', line: 40 }]);
    expect(a).toBe(b);
  });

  it('differs when the error itself changes', () => {
    const a = buildErrorSignature([{ kind: 'type', message: 'Type error: bad', file: 'a.tsx', line: 10 }]);
    const b = buildErrorSignature([{ kind: 'syntax', message: 'Unexpected token', file: 'a.tsx', line: 10 }]);
    expect(a).not.toBe(b);
  });
});

const failed = (overrides: Partial<Awaited<ReturnType<typeof checkBuild>>> = {}) => ({
  status: 'failed' as const,
  stack: 'NEXTJS' as const,
  errors: [{ kind: 'type' as const, message: 'Type error: bad', file: 'app/page.tsx', line: 12 }],
  missingPackages: [],
  signature: 'type:app/page.tsx:type error: bad',
  ...overrides,
});

describe('decideAutoFix — when NOT to retry', () => {
  it('does nothing when the build passed', () => {
    const decision = decideAutoFix({ result: { ...failed(), status: 'passed', errors: [], signature: null }, attempt: 0 });
    expect(decision).toEqual({ action: 'none', reason: 'build-passed' });
  });

  it('does nothing when the check was skipped — absence of evidence is not a fault', () => {
    const decision = decideAutoFix({ result: { ...failed(), status: 'skipped', errors: [], signature: null }, attempt: 0 });
    expect(decision).toEqual({ action: 'none', reason: 'build-skipped' });
  });

  it('stops when the same failure repeats, rather than looping on a bill', () => {
    const result = failed();
    const decision = decideAutoFix({ result, attempt: 1, previousSignature: result.signature });
    expect(decision).toMatchObject({ action: 'stop', reason: 'no-progress' });
  });

  it('stops once the attempt cap is reached', () => {
    const decision = decideAutoFix({ result: failed(), attempt: MAX_AUTOFIX_ATTEMPTS });
    expect(decision).toMatchObject({ action: 'stop', reason: 'attempts-exhausted' });
  });
});

describe('decideAutoFix — when to retry', () => {
  it('installs rather than re-prompting when every error is a missing dependency', () => {
    const decision = decideAutoFix({
      result: failed({
        errors: [{ kind: 'missing-package', message: "Can't resolve 'framer-motion'", file: null, line: null }],
        missingPackages: ['framer-motion'],
      }),
      attempt: 0,
    });
    expect(decision).toEqual({ action: 'install', reason: 'missing-packages', packages: ['framer-motion'] });
  });

  it('re-prompts on a code error and advances the attempt counter', () => {
    const decision = decideAutoFix({ result: failed(), attempt: 0 });
    expect(decision).toMatchObject({ action: 'reprompt', attempt: 1 });
  });

  it('allows a second attempt when the failure changed', () => {
    const decision = decideAutoFix({ result: failed(), attempt: 1, previousSignature: 'something:else' });
    expect(decision).toMatchObject({ action: 'reprompt', attempt: 2 });
  });

  it('still asks to install when a second round of packages is missing', () => {
    // run-build-validation stops rather than installing again, but the policy
    // must keep reporting 'install' so that path stays distinguishable from a
    // code error — the orchestrator decides whether to act on it.
    const decision = decideAutoFix({
      result: failed({
        errors: [{ kind: 'missing-package', message: "Can't resolve 'zod'", file: null, line: null }],
        missingPackages: ['zod'],
        signature: 'missing-package:?:can\'t resolve \'zod\'',
      }),
      attempt: 1,
      previousSignature: 'type:app/page.tsx:type error: bad',
    });
    expect(decision).toMatchObject({ action: 'install', packages: ['zod'] });
  });
});

describe('buildBuildFixInstruction', () => {
  it('names the failing files and forbids redesign', () => {
    const instruction = buildBuildFixInstruction(failed());
    expect(instruction).toContain('app/page.tsx');
    expect(instruction).toContain('Type error: bad');
    expect(instruction.toLowerCase()).toContain('do not redesign');
  });

  it('calls out missing dependencies explicitly', () => {
    const instruction = buildBuildFixInstruction(failed({ missingPackages: ['framer-motion'] }));
    expect(instruction).toContain('framer-motion');
  });

  it('lists each named file once', () => {
    const files = filesFromErrors([
      { kind: 'type', message: 'a', file: 'app/page.tsx', line: 1 },
      { kind: 'type', message: 'b', file: 'app/page.tsx', line: 2 },
      { kind: 'type', message: 'c', file: null, line: null },
    ]);
    expect(files).toEqual(['app/page.tsx']);
  });
});
