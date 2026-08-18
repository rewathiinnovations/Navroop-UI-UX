import { describe, expect, it } from 'vitest';
import {
  formatSummary,
  runVerify,
  stepsForMode,
  VERIFY_STEPS,
} from '../../lib/verify/orchestrator';

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
        return { ok: true };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep?.id).toBe('eslint');
    expect(result.reproduce).toBe('pnpm exec eslint . --max-warnings 0');
    expect(ran.some((row) => row.includes('tsc'))).toBe(true);
    expect(ran.some((row) => row.includes('vitest'))).toBe(false);
    expect(result.summaryLines.some((line) => line.startsWith('✗ ESLint'))).toBe(true);
    expect(result.summaryLines.join('\n')).toContain('Reproduce: pnpm exec eslint . --max-warnings 0');
  });

  it('fails on a typecheck error and names the tsc command', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('tsc')) return { ok: false, output: 'error TS2322' };
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reproduce).toBe('pnpm exec tsc --noEmit');
  });

  it('fails on schema drift and on next build errors', async () => {
    const drift = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('migrate diff')) return { ok: false };
        return { ok: true };
      },
    });
    expect(drift.ok).toBe(false);
    expect(drift.reproduce).toContain('prisma migrate diff');
    expect(drift.reproduce).toContain('--shadow-database-url');

    const build = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('next build')) return { ok: false };
        return { ok: true };
      },
    });
    expect(build.ok).toBe(false);
    expect(build.reproduce).toBe('pnpm exec next build');
  });

  it('fails on a failing test step', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('vitest')) return { ok: false, output: 'FAIL' };
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reproduce).toBe('pnpm exec vitest run --coverage');
  });

  it('continues after depcheck/knip report failures', async () => {
    const result = await runVerify({
      mode: 'verify',
      async runCommand(command) {
        if (command.includes('depcheck') || command.includes('knip')) return { ok: false };
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.results.find((row) => row.id === 'depcheck')?.ok).toBe(false);
    expect(result.results.find((row) => row.id === 'knip')?.ok).toBe(false);
  });

  it('verify:full replaces critical Playwright with all stacks', () => {
    const ids = stepsForMode('verify:full').map((step) => step.id);
    expect(ids).not.toContain('playwright-critical');
    expect(ids).toContain('playwright-all');
    expect(VERIFY_STEPS.map((step) => step.id)).toContain('playwright-critical');
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
          command: 'pnpm exec depcheck',
          fatal: false,
          ok: false,
          durationMs: 400,
        },
      ],
      summaryLines: [],
    });
    expect(lines[0]).toMatch(/✓ Typecheck\s+2\.1s/);
    expect(lines[1]).toMatch(/✗ depcheck \(report\)\s+0\.4s/);
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
      async runCommand() {
        return { ok: true };
      },
    });
    expect(full.ok).toBe(true);
    expect(full.mode).toBe('verify:full');
    expect(full.results.map((row) => row.id)).toContain('playwright-all');
    expect(full.results.map((row) => row.id)).not.toContain('playwright-critical');
  });
});
