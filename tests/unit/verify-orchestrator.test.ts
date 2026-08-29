import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatSummary,
  LIGHT_DEFERRED_STEP_IDS,
  requireExecuted,
  runVerify,
  stepsForMode,
  VERIFY_STEPS,
} from '../../lib/verify/orchestrator';

/**
 * The Playwright steps fail on a zero exit code that reported no passing test, so
 * a stub that answers `{ ok: true }` with no output is a *failing* Playwright run
 * now. The `secret-scan` step is the same shape: exit 0 proves nothing unless the
 * scanner said how many files it read. Every happy-path stub has to speak the
 * reporter's language.
 */
const PLAYWRIGHT_PASSED = '  2 passed (4.1s)';
const SECRETS_SCANNED = 'Secret scan passed (1923 file(s) scanned, 172 ignored).';

function stubOk(command: string) {
  if (command.includes('playwright')) return { ok: true, output: PLAYWRIGHT_PASSED };
  if (command.includes('secret-scan')) return { ok: true, output: SECRETS_SCANNED };
  return { ok: true };
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

  it('continues after a knip report failure but stops on depcheck', async () => {
    const reportOnly = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('knip')) return { ok: false };
        return stubOk(command);
      },
    });
    expect(reportOnly.ok).toBe(true);
    expect(reportOnly.results.find((row) => row.id === 'knip')?.ok).toBe(false);

    // depcheck became fatal on 2026-08-21 once `.depcheckrc.yml` declared the ten
    // entries it had been printing on every run (F-645). A newly unused dependency
    // now stops the push instead of scrolling past.
    const unusedDependency = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('depcheck'))
          return { ok: false, output: 'Unused dependencies\n* left-pad' };
        return stubOk(command);
      },
    });
    expect(unusedDependency.ok).toBe(false);
    expect(unusedDependency.failedStep?.id).toBe('depcheck');
    // And it stops there: knip and the audit never run.
    expect(unusedDependency.results.map((row) => row.id)).not.toContain('audit');
  });

  it('never reaches for pnpm except for the audit, which has no vendored binary', () => {
    const shims = stepsForMode('verify:full')
      .filter((step) => step.command.includes('pnpm'))
      .map((step) => step.id);
    expect(shims).toEqual(['audit']);
  });

  /**
   * `verify:light` is what .husky/pre-push runs (2026-08-29): a push was paying
   * ~5.5 minutes for a gate whose slow half is re-run by CI on the same push
   * (.github/workflows/verify.yml). The mode must stay a *deferral*, not a hole:
   * every skipped id names a real VERIFY_STEPS entry, the summary prints each one
   * it skipped, and the two entries that must never wait for CI — the secret scan
   * (a credential reported by CI has already left the machine) and the audit —
   * still run locally.
   */
  describe('verify:light — the pre-push deferral', () => {
    const light = stepsForMode('verify:light');

    it('defers exactly the declared ids, all of which exist, and keeps the order', () => {
      const all = VERIFY_STEPS.map((step) => step.id);
      for (const id of LIGHT_DEFERRED_STEP_IDS) expect(all).toContain(id);
      expect(light.map((step) => step.id)).toEqual(
        all.filter((id) => !LIGHT_DEFERRED_STEP_IDS.includes(id)),
      );
    });

    it('keeps the secret scan and the audit local', () => {
      const ids = light.map((step) => step.id);
      expect(ids).toContain('secret-scan');
      expect(ids).toContain('audit');
    });

    it('runs vitest without the coverage ratchet, changing nothing else', () => {
      const vitest = light.find((step) => step.id === 'vitest');
      expect(vitest?.command).toBe('node ./node_modules/vitest/vitest.mjs run');
      expect(vitest?.fatal).toBe(true);
      // The light rewrite must not leak back into the canonical list.
      expect(VERIFY_STEPS.find((step) => step.id === 'vitest')?.command).toContain('--coverage');
    });

    it('prints one deferred line per skipped entry, so the summary cannot read as "everything ran"', async () => {
      const result = await runVerify({
        mode: 'verify:light',
        async runCommand(command) {
          return stubOk(command);
        },
      });
      expect(result.ok).toBe(true);
      expect(result.results.map((row) => row.id)).not.toContain('next-build');
      const deferred = result.summaryLines.filter((line) => line.includes('deferred to CI'));
      expect(deferred).toHaveLength(LIGHT_DEFERRED_STEP_IDS.length);
      expect(deferred.join('\n')).toContain('Next.js build');
      expect(deferred.join('\n')).toContain('.github/workflows/verify.yml');
    });
  });

  /**
   * F-785. `.husky/pre-commit` scans the index, and `verify:bypass` documents
   * `git push --no-verify` as a supported escape hatch — so a commit made that way
   * was never scanned for secrets by anything, ever again. The gate now re-reads
   * the tracked tree on every push.
   */
  describe('the secret scan a bypassed commit finally gets', () => {
    const scan = VERIFY_STEPS.find((step) => step.id === 'secret-scan');

    it('runs the tracked-tree scan as a fatal step, before the slow ones', () => {
      expect(scan?.command).toBe(
        'node ./node_modules/tsx/dist/cli.mjs scripts/secret-scan.ts --tracked',
      );
      expect(scan?.fatal).toBe(true);
      const ids = VERIFY_STEPS.map((step) => step.id);
      // A leaked credential must be reported in the first seconds of a push, not
      // after ten minutes of Playwright.
      expect(ids.indexOf('secret-scan')).toBeLessThan(ids.indexOf('vitest'));
      expect(ids.indexOf('secret-scan')).toBeLessThan(ids.indexOf('playwright-critical'));
    });

    it('stops the run on a finding and names the command to reproduce it', async () => {
      const result = await runVerify({
        mode: 'verify',
        async runCommand(command) {
          if (command.includes('secret-scan')) {
            // Exit 1: the scanner matched a credential pattern.
            return { ok: false, output: '  .env.production:4  provider-key-sk' };
          }
          return stubOk(command);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.failedStep?.id).toBe('secret-scan');
      expect(result.reproduce).toContain('scripts/secret-scan.ts --tracked');
      // Fatal, so nothing after it ran.
      expect(result.results.map((row) => row.id)).not.toContain('vitest');
    });

    it('treats exit 2 — a scan that could not run — as a failure, not a pass', async () => {
      // `scripts/secret-scan.ts` fails closed and separates "found a secret" (1)
      // from "examined nothing" (2). A broken gate must not print a ✓: that is the
      // state in which a real secret sails through unnoticed.
      const result = await runVerify({
        mode: 'verify',
        async runCommand(command) {
          if (command.includes('secret-scan')) {
            return {
              ok: false,
              output: 'Secret scan could not run: git could not list the tracked files',
            };
          }
          return stubOk(command);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.failedStep?.id).toBe('secret-scan');
      expect(result.summaryLines.some((line) => line.startsWith('✗ Secret scan'))).toBe(true);
      expect(result.summaryLines.some((line) => line.startsWith('✓ Secret scan'))).toBe(false);
    });

    it('fails a scan that exited 0 without reporting a scanned file', async () => {
      // The "nothing to scan" exit-0 path. Correct for pre-commit on an empty
      // index; as a gate over the whole tracked tree it means the enumeration came
      // back empty and the ✓ covers an unexamined repository.
      const result = await runVerify({
        mode: 'verify',
        async runCommand(command) {
          if (command.includes('secret-scan')) {
            return {
              ok: true,
              output:
                'Secret scan: git reported no tracked file to scan (0 path(s) listed, 0 ignored by path rules). Nothing to scan — this is not a failed scan.',
            };
          }
          return stubOk(command);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.failedStep?.id).toBe('secret-scan');
      expect(result.failedStep?.failureReason).toBe(
        'exited 0 without reporting a scanned file — the gate examined nothing',
      );
    });

    it('accepts a scan that read files and found nothing', () => {
      expect(scan?.assertExecuted?.(SECRETS_SCANNED)).toBeNull();
      // A zero count is not a clean scan either.
      expect(scan?.assertExecuted?.('Secret scan passed (0 file(s) scanned, 0 ignored).')).toBe(
        'exited 0 without reporting a scanned file — the gate examined nothing',
      );
    });
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
      // Bare `{ ok: true }` for the Playwright commands only. Every other
      // output-asserting step has to clear its own assertion, or the run stops
      // before Playwright and this stops being a test about Playwright.
      async runCommand(command) {
        return command.includes('playwright') ? { ok: true } : stubOk(command);
      },
    });
    expect(noOutput.ok).toBe(false);
    expect(noOutput.failedStep?.id).toBe('playwright-critical');
  });

  it('requires a passing test and rejects undeclared skips', () => {
    const gate = requireExecuted();
    expect(gate('  2 passed (4.1s)')).toBeNull();
    // The F-611 regression: a passing count no longer excuses a skip in a gated step.
    expect(gate('  1 passed\n  37 skipped')).toContain('skipped');
    expect(gate('  1 passed\n  1 skipped')).toContain('skipped');
    expect(gate('  37 skipped')).toContain('no passing test');
    expect(gate('')).toContain('no passing test');
    expect(gate('  0 passed')).toContain('no passing test');

    // playwright-all runs the honestly-skipped `stacks` project, so it declares one.
    const withDeclaredSkip = requireExecuted({ allowSkipped: 1 });
    expect(withDeclaredSkip('  4 passed\n  1 skipped')).toBeNull();
    expect(withDeclaredSkip('  4 passed\n  2 skipped')).toContain('skipped');
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

  /**
   * F-615: a project added to `playwright.config.ts` is gated by nothing until
   * someone remembers to add a step for it. `tests/unit/test-suites-reachable.test.ts`
   * proves a spec is *collectable* by some project; it says nothing about whether that
   * project runs in `verify`. Before 2026-08-19 `authenticated` was in no workflow and
   * no verify step, which is how a broken sign-in could have shipped green.
   *
   * Every project therefore has to be in exactly one of three buckets, and a new name
   * lands in none of them until it is declared here.
   */
  describe('every Playwright project is accounted for by the gate', () => {
    /** Runs only in `verify:full` (nightly). Declared, not accidental. */
    const NIGHTLY_ONLY = ['stacks', 'full'];
    /** Never run standalone: `dependencies: ['setup']` pulls it into `authenticated`. */
    const DEPENDENCY_ONLY = ['setup'];

    const config = readFileSync(
      fileURLToPath(new URL('../../playwright.config.ts', import.meta.url)),
      'utf8',
    );
    const projectNames = [...config.matchAll(/^\s{6}name: '([a-z-]+)',$/gm)].map(
      (match) => match[1],
    );
    const gatedInVerify = VERIFY_STEPS.flatMap((step) => {
      const match = /--project=([a-z-]+)/.exec(step.command);
      return match?.[1] ? [match[1]] : [];
    });

    it('finds the project list and the gated subset', () => {
      // Anti-vacuity: an empty parse would satisfy every set comparison below.
      expect(projectNames.length).toBeGreaterThan(3);
      expect(gatedInVerify.length).toBeGreaterThan(1);
    });

    it('leaves no project ungated and no declaration stale', () => {
      expect([...projectNames].sort()).toEqual(
        [...gatedInVerify, ...NIGHTLY_ONLY, ...DEPENDENCY_ONLY].sort(),
      );
    });

    it('runs the nightly-only projects somewhere', () => {
      // `playwright-all` carries no --project flag, so it covers the whole config.
      const full = stepsForMode('verify:full').filter((step) => step.id.startsWith('playwright'));
      expect(full.map((step) => step.id)).toEqual(['playwright-all']);
      expect(full[0]?.command).not.toContain('--project=');
      expect(full[0]?.fatal).toBe(true);
    });
  });
});
