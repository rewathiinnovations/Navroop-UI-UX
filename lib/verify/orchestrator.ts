import { prismaMigrateDiffCommand } from './schema-drift';

/**
 * Checks the output of a step that already exited 0. Returns a reason to fail it,
 * or null to leave it green.
 */
export type StepAssertion = (output: string) => string | null;

export type VerifyStep = {
  id: string;
  label: string;
  command: string;
  fatal: boolean;
  /**
   * Applied only when the command exited 0, because an exit code of 0 does not
   * mean the step proved anything. Verified 2026-08-19:
   * `playwright test --project=critical --grep "publish is a job"` prints
   * `1 skipped` and exits **0**, and the summary printed `✓ Playwright critical`
   * beside a fatal gate step that had executed no assertion. (A filter that
   * collects nothing at all is already fatal on its own — Playwright prints
   * `Error: No tests found` and exits 1 — so this covers the skipped case, which
   * is the one a `.fixme()` or a `test.skip(cond)` produces.)
   */
  assertExecuted?: StepAssertion;
};

export type VerifyStepResult = {
  id: string;
  label: string;
  command: string;
  fatal: boolean;
  ok: boolean;
  durationMs: number;
  output?: string;
  /** Why the step is red despite a zero exit code (see `assertExecuted`). */
  failureReason?: string;
};

export type VerifyRunResult = {
  ok: boolean;
  mode: 'verify' | 'verify:full';
  results: VerifyStepResult[];
  failedStep?: VerifyStepResult;
  reproduce?: string;
  summaryLines: string[];
};

export type RunCommand = (command: string) => Promise<{ ok: boolean; output?: string }>;

const PASSED_TESTS = /(\d+)\s+passed/;
const SKIPPED_TESTS = /(\d+)\s+skipped/;

/**
 * Playwright's reporter prints `N passed` only when tests actually ran, and
 * `N skipped` for every `test.skip(cond)` / `.fixme()`. A fatal project that has
 * passing tests *and* a conditional skip prints e.g. `12 passed  1 skipped` and
 * exits 0 — a check that reads only the pass count leaves that skip invisible, so
 * the one journey a skip guards can stop running without turning the gate red
 * (F-611). This asserts both: at least one assertion ran, and no more skips than
 * the step has declared. A new conditional skip inside a gated project therefore
 * has to be declared here (bump `allowSkipped`) or it fails the step.
 *
 * `allowSkipped` is non-zero only for `playwright-all` in verify:full, which runs
 * the `stacks` project whose single "needs a paid build" skip is honest and
 * permanent; every per-project gate step allows zero.
 */
export function requireExecuted({
  allowSkipped = 0,
}: { allowSkipped?: number } = {}): StepAssertion {
  return (output: string) => {
    const passedMatch = PASSED_TESTS.exec(output);
    const passed = passedMatch ? Number(passedMatch[1]) : 0;
    if (passed <= 0) {
      return 'exited 0 but reported no passing test — a step that runs nothing is not a pass';
    }
    const skippedMatch = SKIPPED_TESTS.exec(output);
    const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;
    if (skipped > allowSkipped) {
      return `exited 0 but ${skipped} test(s) skipped (declared ${allowSkipped}) — a skip inside a fatal step must be declared, not hidden behind the passing count`;
    }
    return null;
  };
}

/**
 * Every command is a direct binary. `pnpm run` / `pnpm exec` first run a
 * dependency-status check that can decide node_modules is stale and purge it, and
 * this list is reached from a real `git push` through .husky/pre-push, which has
 * a TTY to confirm the purge on (.cursor/lessons-learned.md). The hook was
 * careful to avoid the shim and then every step it ran reintroduced it.
 */
export const VERIFY_STEPS: VerifyStep[] = [
  {
    id: 'tsc',
    label: 'Typecheck',
    command: 'node ./node_modules/typescript/bin/tsc --noEmit',
    fatal: true,
  },
  {
    id: 'eslint',
    label: 'ESLint',
    command: 'node ./node_modules/eslint/bin/eslint.js . --max-warnings 0',
    fatal: true,
  },
  {
    id: 'public-routes',
    label: 'Public API allowlist',
    command: 'node ./node_modules/tsx/dist/cli.mjs scripts/check-public-routes.ts',
    fatal: true,
  },
  {
    id: 'prisma-validate',
    label: 'Prisma validate',
    command: 'node ./node_modules/prisma/build/index.js validate',
    fatal: true,
  },
  {
    id: 'schema-drift',
    label: 'Schema drift',
    command: prismaMigrateDiffCommand(),
    fatal: true,
  },
  {
    id: 'destructive',
    label: 'Destructive migration detector',
    command: 'node ./node_modules/tsx/dist/cli.mjs scripts/check-destructive-migrations.ts',
    fatal: true,
  },
  {
    id: 'vitest',
    label: 'Vitest + coverage',
    command: 'node ./node_modules/vitest/vitest.mjs run --coverage',
    fatal: true,
  },
  {
    id: 'next-build',
    label: 'Next.js build',
    command: 'node ./node_modules/next/dist/bin/next build',
    fatal: true,
  },
  {
    id: 'playwright-critical',
    label: 'Playwright critical',
    command: 'node ./node_modules/@playwright/test/cli.js test --project=critical',
    fatal: true,
    assertExecuted: requireExecuted(),
  },
  {
    // Runs `setup` first as a declared dependency, so this is the step that
    // proves sign-in, the dashboard and project creation still work as a real
    // signed-in user. It is a separate step from `critical` on purpose: merged
    // into one command, a silently empty `authenticated` project would hide
    // behind `critical`'s passing count.
    id: 'playwright-authenticated',
    label: 'Playwright authenticated journeys',
    command: 'node ./node_modules/@playwright/test/cli.js test --project=authenticated',
    fatal: true,
    assertExecuted: requireExecuted(),
  },
  {
    // Fatal since 2026-08-21. It was `fatal: false` with no config, so it printed the
    // same ten entries on every run and blocked nothing — the same shape as a test
    // that cannot fail (F-645). `.depcheckrc.yml` now declares each of those ten,
    // split into "used but not through an import depcheck can see" and "unused,
    // pending removal", so depcheck exits 0 on a clean tree and a *new* unused
    // dependency is a red gate. knip stays a report: its unused list is wider because
    // it reads the components/shared/* marketing surface as unreachable (F-448).
    id: 'depcheck',
    label: 'depcheck',
    command: 'node ./node_modules/depcheck/bin/depcheck.js',
    fatal: true,
  },
  {
    // `--no-exit-code` was removed on 2026-08-19: with `fatal: false` on top of
    // it, knip's findings were reported twice over and enforced never, and the
    // summary printed a ✓ that claimed knip had found nothing. The tick now
    // reflects what knip actually said; the step still does not block a push.
    id: 'knip',
    label: 'knip (report)',
    command: 'node ./node_modules/knip/bin/knip.js',
    fatal: false,
  },
  {
    // The one remaining pnpm call: `audit` resolves the lockfile itself and has
    // no vendored binary equivalent. It is not a script runner, so it does not
    // trigger the dependency-status purge that `pnpm run` / `pnpm exec` do.
    id: 'audit',
    label: 'Dependency audit (high)',
    command: 'pnpm audit --audit-level=high',
    fatal: true,
  },
];

export const VERIFY_FULL_EXTRA_STEPS: VerifyStep[] = [
  {
    id: 'playwright-all',
    label: 'Playwright all projects',
    command: 'node ./node_modules/@playwright/test/cli.js test',
    fatal: true,
    assertExecuted: requireExecuted({ allowSkipped: 1 }),
  },
];

export function stepsForMode(mode: 'verify' | 'verify:full') {
  if (mode === 'verify:full') {
    // `playwright-all` runs every project, so the two per-project Playwright
    // steps would only repeat work it already covers.
    const withoutProjectRuns = VERIFY_STEPS.filter(
      (step) => step.id !== 'playwright-critical' && step.id !== 'playwright-authenticated',
    );
    return [...withoutProjectRuns, ...VERIFY_FULL_EXTRA_STEPS];
  }
  return VERIFY_STEPS;
}

function tick(ok: boolean) {
  return ok ? '✓' : '✗';
}

export function formatSummary(result: VerifyRunResult) {
  const lines = result.results.map((row) => {
    const seconds = (row.durationMs / 1000).toFixed(1);
    const suffix = row.fatal ? '' : ' (report)';
    const reason = row.failureReason ? ` — ${row.failureReason}` : '';
    return `${tick(row.ok)} ${row.label}${suffix}  ${seconds}s${reason}`;
  });
  if (!result.ok && result.reproduce) {
    lines.push('');
    lines.push(`Failed. Reproduce: ${result.reproduce}`);
  }
  return lines;
}

export async function runVerify(options: {
  mode: 'verify' | 'verify:full';
  runCommand: RunCommand;
  now?: () => number;
}): Promise<VerifyRunResult> {
  const now = options.now ?? Date.now;
  const steps = stepsForMode(options.mode);
  const results: VerifyStepResult[] = [];

  for (const step of steps) {
    const started = now();
    const ran = await options.runCommand(step.command);
    const durationMs = Math.max(0, now() - started);
    // A zero exit code only opens the question; `assertExecuted` decides whether
    // the step proved anything. Skipped when the command already failed, so the
    // real error stays the reported one.
    const failureReason =
      ran.ok && step.assertExecuted ? step.assertExecuted(ran.output ?? '') : null;
    const row: VerifyStepResult = {
      id: step.id,
      label: step.label,
      command: step.command,
      fatal: step.fatal,
      ok: ran.ok && failureReason === null,
      durationMs,
      output: ran.output,
      failureReason: failureReason ?? undefined,
    };
    results.push(row);
    if (!row.ok && step.fatal) {
      const failed: VerifyRunResult = {
        ok: false,
        mode: options.mode,
        results,
        failedStep: row,
        reproduce: step.command,
        summaryLines: [],
      };
      failed.summaryLines = formatSummary(failed);
      return failed;
    }
  }

  const passed: VerifyRunResult = {
    ok: true,
    mode: options.mode,
    results,
    summaryLines: [],
  };
  passed.summaryLines = formatSummary(passed);
  return passed;
}
