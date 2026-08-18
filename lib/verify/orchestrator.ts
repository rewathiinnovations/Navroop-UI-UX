import { prismaMigrateDiffCommand } from './schema-drift';

export type VerifyStep = {
  id: string;
  label: string;
  command: string;
  fatal: boolean;
};

export type VerifyStepResult = {
  id: string;
  label: string;
  command: string;
  fatal: boolean;
  ok: boolean;
  durationMs: number;
  output?: string;
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

export const VERIFY_STEPS: VerifyStep[] = [
  { id: 'tsc', label: 'Typecheck', command: 'pnpm exec tsc --noEmit', fatal: true },
  { id: 'eslint', label: 'ESLint', command: 'pnpm exec eslint . --max-warnings 0', fatal: true },
  {
    id: 'public-routes',
    label: 'Public API allowlist',
    command: 'pnpm exec tsx scripts/check-public-routes.ts',
    fatal: true,
  },
  {
    id: 'prisma-validate',
    label: 'Prisma validate',
    command: 'pnpm exec prisma validate',
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
    command: 'pnpm exec tsx scripts/check-destructive-migrations.ts',
    fatal: true,
  },
  { id: 'vitest', label: 'Vitest + coverage', command: 'pnpm exec vitest run --coverage', fatal: true },
  { id: 'next-build', label: 'Next.js build', command: 'pnpm exec next build', fatal: true },
  {
    id: 'playwright-critical',
    label: 'Playwright critical',
    command: 'pnpm exec playwright test --project=critical',
    fatal: true,
  },
  { id: 'depcheck', label: 'depcheck (report)', command: 'pnpm exec depcheck', fatal: false },
  { id: 'knip', label: 'knip (report)', command: 'pnpm exec knip --no-exit-code', fatal: false },
  {
    id: 'audit',
    label: 'Dependency audit (high)',
    command: 'pnpm audit --audit-level=high',
    fatal: true,
  },
];

export const VERIFY_FULL_EXTRA_STEPS: VerifyStep[] = [
  {
    id: 'playwright-all',
    label: 'Playwright all stacks',
    command: 'pnpm exec playwright test',
    fatal: true,
  },
];

export function stepsForMode(mode: 'verify' | 'verify:full') {
  if (mode === 'verify:full') {
    return [...VERIFY_STEPS.filter((step) => step.id !== 'playwright-critical'), ...VERIFY_FULL_EXTRA_STEPS];
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
    return `${tick(row.ok)} ${row.label}${suffix}  ${seconds}s`;
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
    const row: VerifyStepResult = {
      id: step.id,
      label: step.label,
      command: step.command,
      fatal: step.fatal,
      ok: ran.ok,
      durationMs,
      output: ran.output,
    };
    results.push(row);
    if (!ran.ok && step.fatal) {
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
