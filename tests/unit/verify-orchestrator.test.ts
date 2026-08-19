import { describe, expect, it } from 'vitest';
import {
  formatSummary,
  requirePassingTests,
  runVerify,
  stepsForMode,
  VERIFY_STEPS,
} from '../../lib/verify/orchestrator';

/**
 * The Playwright steps fail on a zero exit code that reported no passing test, so
 * a stub that answers `{ ok: true }` with no output is a *failing* Playwright run
 * now. Every happy-path stub has to speak the reporter's language.
 */
const PLAYWRIGHT_PASSED = '  2 passed (4.1s)';

function stubOk(command: string) {
  return command.includes('playwright') ? { ok: true, output: PLAYWRIGHT_PASSED } : { ok: true };
}

describe('verify orchestrator', () => {
  it('runs verify steps in order and stops on the first fatal failure', async () => {
    const ran: string[] = [];
    const result = await runVerify({
      mode: 'verify',
      now: (() => {
        let t = 0;
        return () => {
          t += 1000;
          return t;
        };
      })(),
      async runCommand(command) {
        ran.push(command);
        if (command.includes('eslint')) return { ok: false, output: 'warning' };
        return stubOk(command);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep?.id).toBe('eslint');
    expect(result.reproduce).toBe('node ./node_modules/eslint/bin/eslint.js . --max-warnings 0');
    expect(ran.some((row) => row.includes('tsc'))).toBe(true);
    expect(ran.some((row) => row.includes('vitest'))).toBe(false);
    expect(result.summaryLines.some((line) => line.startsWith('✗ ESLint'))).toBe(true);
    expect(result.summaryLines.join('\n')).toContain(
      'Reproduce: node ./node_modules/eslint/bin/eslint.js . --max-warnings 0',
    );
  });

  it('fails on a typecheck error and names the tsc command', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('tsc')) return { ok: false, output: 'error TS2322' };
        return stubOk(command);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reproduce).toBe('node ./node_modules/typescript/bin/tsc --noEmit');
  });

  it('fails on schema drift and on next build errors', async () => {
    const drift = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('migrate diff')) return { ok: false };
        return stubOk(command);
      },
    });
    expect(drift.ok).toBe(false);
    expect(drift.reproduce).toContain('migrate diff');
    expect(drift.reproduce).toContain('--shadow-database-url');

    const build = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('next build')) return { ok: false };
        return stubOk(command);
      },
    });
    expect(build.ok).toBe(false);
    expect(build.reproduce).toBe('node ./node_modules/next/dist/bin/next build');
  });

  it('fails on a failing test step', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('vitest')) return { ok: false, output: 'FAIL' };
        return stubOk(command);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reproduce).toBe('node ./node_modules/vitest/vitest.mjs run --coverage');
  });

  it('continues after depcheck/knip report failures', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('depcheck') || command.includes('knip')) return { ok: false };
        return stubOk(command);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.results.find((row) => row.id === 'depcheck')?.ok).toBe(false);
    expect(result.results.find((row) => row.id === 'knip')?.ok).toBe(false);
  });

  it('never reaches for pnpm except for the audit, which has no vendored binary', () => {
    const shims = stepsForMode('verify:full')
      .filter((step) => step.command.includes('pnpm'))
      .map((step) => step.id);
    expect(shims).toEqual(['audit']);
  });

  it('fails a Playwright step that exited 0 without running a test', async () => {
    const allSkipped = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        // Verbatim shape of a real all-skipped run: `playwright test
        // --project=critical --grep "publish is a job"` prints exactly this and
        // exits 0, which used to print as `✓ Playwright critical`.
        if (command.includes('--project=authenticated')) {
          return { ok: true, output: '\nRunning 5 tests using 2 workers\n\n  5 skipped\n' };
        }
        return stubOk(command);
      },
    });

    expect(allSkipped.ok).toBe(false);
    expect(allSkipped.failedStep?.id).toBe('playwright-authenticated');
    expect(allSkipped.failedStep?.failureReason).toContain('no passing test');
    expect(
      allSkipped.summaryLines.some((line) => line.startsWith('✗ Playwright authenticated')),
    ).toBe(true);
    // The step it hides behind must not have been reported as run.
    expect(allSkipped.results.some((row) => row.id === 'audit')).toBe(false);

    const noOutput = await runVerify({
      mode: 'verify',
      async runCommand() {
        return { ok: true };
      },
    });
    expect(noOutput.ok).toBe(false);
    expect(noOutput.failedStep?.id).toBe('playwright-critical');
  });

  it('counts passing tests out of the reporter output', () => {
    expect(requirePassingTests('  2 passed (4.1s)')).toBeNull();
    expect(requirePassingTests('  1 passed\n  37 skipped')).toBeNull();
    expect(requirePassingTests('  37 skipped')).toContain('no passing test');
    expect(requirePassingTests('')).toContain('no passing test');
    expect(requirePassingTests('  0 passed')).toContain('no passing test');
  });

  it('runs both Playwright projects in verify and replaces them with every project in verify:full', () => {
    const ids = stepsForMode('verify:full').map((step) => step.id);
    expect(ids).not.toContain('playwright-critical');
    expect(ids).not.toContain('playwright-authenticated');
    expect(ids).toContain('playwright-all');

    const gate = VERIFY_STEPS.filter((step) => step.id.startsWith('playwright-'));
    expect(gate.map((step) => step.id)).toEqual([
      'playwright-critical',
      'playwright-authenticated',
    ]);
    // Both are fatal and both assert they executed something: the authenticated
    // journeys are the only e2e coverage of a signed-in user, and until
    // 2026-08-19 they ran in no gate at all.
    expect(gate.every((step) => step.fatal && step.assertExecuted !== undefined)).toBe(true);
  });

  it('formats ticks and durations', () => {
    const lines = formatSummary({
      ok: true,
      mode: 'verify',
      results: [
        {
          id: 'tsc',
          label: 'Typecheck',
          command: 'pnpm exec tsc --noEmit',
          fatal: true,
          ok: true,
          durationMs: 2100,
        },
        {
          id: 'depcheck',
          label: 'depcheck',
          command: 'node ./node_modules/depcheck/bin/depcheck.js',
          fatal: false,
          ok: false,
          durationMs: 400,
        },
        {
          id: 'playwright-authenticated',
          label: 'Playwright authenticated journeys',
          command: 'node ./node_modules/@playwright/test/cli.js test --project=authenticated',
          fatal: true,
          ok: false,
          durationMs: 3000,
          failureReason: 'exited 0 but reported no passing test',
        },
      ],
      summaryLines: [],
    });
    expect(lines[0]).toMatch(/✓ Typecheck\s+2\.1s/);
    expect(lines[1]).toMatch(/✗ depcheck \(report\)\s+0\.4s/);
    // The user has to be told why a step that exited 0 is red.
    expect(lines[2]).toMatch(
      /✗ Playwright authenticated journeys\s+3\.0s — exited 0 but reported no passing test/,
    );
  });

  it('omits the reproduce footer when a failed summary has no command', () => {
    const lines = formatSummary({
      ok: false,
      mode: 'verify',
      results: [],
      summaryLines: [],
    });
    expect(lines.join('\n')).not.toContain('Failed. Reproduce');
  });

  it('clamps a backwards clock to zero and runs verify:full to completion', async () => {
    let t = 5_000;
    const failed = await runVerify({
      mode: 'verify',
      now: () => {
        t -= 250;
        return t;
      },
      async runCommand() {
        return { ok: false };
      },
    });
    expect(failed.results[0]?.durationMs).toBe(0);

    const full = await runVerify({
      mode: 'verify:full',
      async runCommand(command) {
        return stubOk(command);
      },
    });
    expect(full.ok).toBe(true);
    expect(full.mode).toBe('verify:full');
    expect(full.results.map((row) => row.id)).toContain('playwright-all');
    expect(full.results.map((row) => row.id)).not.toContain('playwright-critical');
  });
});
