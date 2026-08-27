import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGeneratedImports } from '@/lib/validation/import-check';
import { checkBuild } from '@/lib/validation/build-check';
import { runBuildValidation } from '@/lib/validation/run-build-validation';
import { invalidateSettingsCache } from '@/lib/settings/resolve';

/**
 * Validation used to be unreachable in two ways at once: `runBuildValidation`
 * had no caller, and the check underneath it shelled a build command into a
 * sandbox that no longer exists — `docs/build-autofix.md` described a loop that
 * could not run. The visible consequence was
 * `No matching export in "vfs:lib/data.ts" for import "site"` in the user's
 * preview, after chat said the build had succeeded.
 *
 * These cover the wiring: a check that cannot skip, a failure the user is always
 * told about, and a repair that only happens when the policy allows it.
 */

const autoFixSetting = { value: null as string | null };
const recordJobStepFailure = vi.fn(async () => undefined);

/**
 * The toggle resolves through `lib/settings/resolve.ts` now, so the stored row is
 * the registry's shape — key `setting:<registry key>`, value a JSON envelope —
 * and not the bare `buildAutoFixEnabled` row this file used to fake. The bare row
 * was the defect: nothing could write it, because /admin/config only ever writes
 * through the registry.
 */
vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: async () =>
        autoFixSetting.value === null
          ? null
          : { value: JSON.stringify({ value: autoFixSetting.value, encrypted: false }) },
    },
  },
}));

vi.mock('@/lib/jobs/step-failure', () => ({
  recordJobStepFailure: (...args: unknown[]) =>
    (recordJobStepFailure as unknown as (...inner: unknown[]) => Promise<undefined>)(...args),
}));

/**
 * The bundle compile is real by default — the agreement test below depends on it
 * — and switchable so the two "could not check" paths can be exercised without a
 * broken esbuild install.
 */
const bundleCheck = { mode: 'real' as 'real' | 'throws' | 'unavailable' };

vi.mock('@/lib/validation/build-check', async (importOriginal) => {
  // importOriginal is the only way to keep the real implementation reachable from
  // inside a mock factory, which vitest hoists above the static imports.
  const actual = await importOriginal<typeof import('@/lib/validation/build-check')>();
  return {
    ...actual,
    checkBuild: async (args: Parameters<typeof actual.checkBuild>[0]) => {
      if (bundleCheck.mode === 'throws') throw new Error('spawn esbuild ENOENT');
      if (bundleCheck.mode === 'unavailable') {
        return {
          status: 'skipped' as const,
          stack: args.stack,
          errors: [],
          missingPackages: [],
          signature: null,
          skipReason: 'checker-unavailable' as const,
        };
      }
      return actual.checkBuild(args);
    },
  };
});

/** The generated site from the incident, minus the bad import. */
const GOOD_FILES: Record<string, string> = {
  'app/page.tsx': [
    "import { siteConfig } from '@/lib/data';",
    "import { Hero } from '@/components/Hero';",
    'export default function Page() {',
    '  return <Hero title={siteConfig.name} />;',
    '}',
  ].join('\n'),
  'components/Hero.tsx': [
    "import { cn } from '@/lib/utils';",
    'export function Hero({ title }: { title: string }) {',
    '  return <h1 className={cn("text-4xl")}>{title}</h1>;',
    '}',
  ].join('\n'),
  'lib/data.ts': "export const siteConfig = { name: 'Nordlys' };",
  'lib/utils.ts': 'export function cn(...parts: string[]) { return parts.join(" "); }',
};

/** The same site as it shipped: `site` was never exported. */
const BROKEN_FILES: Record<string, string> = {
  ...GOOD_FILES,
  'app/page.tsx': [
    "import { site } from '@/lib/data';",
    "import { Hero } from '@/components/Hero';",
    'export default function Page() {',
    '  return <Hero title={site.name} />;',
    '}',
  ].join('\n'),
};

function collectNotices() {
  const notices: Array<{ message: string; level: string }> = [];
  return {
    notices,
    notify: (message: string, level: string) => {
      notices.push({ message, level });
    },
  };
}

beforeEach(() => {
  autoFixSetting.value = null;
  bundleCheck.mode = 'real';
  recordJobStepFailure.mockClear();
  // The resolver caches for 30 s, so without this every case after the first
  // would read the previous case's answer.
  invalidateSettingsCache();
});

describe('checkGeneratedImports', () => {
  it('fails the shipped file map and produces an import error, not a package one', () => {
    const outcome = checkGeneratedImports({ stack: 'NEXTJS', files: BROKEN_FILES });
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.errors.map((error) => error.kind)).toEqual(['import']);
    // Nothing installable: offering an install here would spend a retry on npm.
    expect(outcome.result.missingPackages).toEqual([]);
    expect(outcome.result.signature).toBeTruthy();
    expect(outcome.summary).toContain('site');
  });

  it('passes the corrected file map', () => {
    const outcome = checkGeneratedImports({ stack: 'NEXTJS', files: GOOD_FILES });
    expect(outcome.result.status).toBe('passed');
    expect(outcome.warnings).toEqual([]);
  });

  it('skips only for honest reasons — no module graph, or no files', () => {
    expect(
      checkGeneratedImports({ stack: 'STATIC_HTML', files: { 'index.html': '<h1>Hi</h1>' } }).result
        .skipReason,
    ).toBe('no-build-command');
    expect(checkGeneratedImports({ stack: 'NEXTJS', files: {} }).result.skipReason).toBe(
      'no-files',
    );
  });
});

describe('the static check agrees with the bundler', () => {
  it('fails what esbuild fails and passes what esbuild passes', async () => {
    // The whole point of mirroring `resolveVirtual`: if the two disagree, either
    // a good build gets blocked or a broken one still reaches the browser.
    const broken = await checkBuild({ stack: 'NEXTJS', files: BROKEN_FILES });
    expect(broken.status).toBe('failed');
    expect(checkGeneratedImports({ stack: 'NEXTJS', files: BROKEN_FILES }).result.status).toBe(
      'failed',
    );

    const good = await checkBuild({ stack: 'NEXTJS', files: GOOD_FILES });
    expect(good.status).toBe('passed');
    expect(checkGeneratedImports({ stack: 'NEXTJS', files: GOOD_FILES }).result.status).toBe(
      'passed',
    );
  });
});

describe('runBuildValidation', () => {
  it('asks for a repair, names the symbol, and records the job step', async () => {
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: BROKEN_FILES,
      changedPaths: Object.keys(BROKEN_FILES),
      jobId: 'job-1',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.decision.action).toBe('reprompt');
    expect(outcome.retry?.instruction).toContain('site');
    expect(outcome.retry?.instruction).toContain('lib/data.ts');
    expect(outcome.retry?.attempt).toBe(1);
    expect(outcome.retry?.signature).toBe(outcome.result.signature);
    expect(recordJobStepFailure).toHaveBeenCalledTimes(1);
    expect(
      notices.some((notice) => notice.level === 'warning' && notice.message.includes('site')),
    ).toBe(true);
  });

  it('confirms a clean build once, with no job failure', async () => {
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: GOOD_FILES,
      changedPaths: Object.keys(GOOD_FILES),
      jobId: 'job-2',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.decision).toEqual({ action: 'none', reason: 'build-passed' });
    expect(outcome.retry).toBeNull();
    expect(recordJobStepFailure).not.toHaveBeenCalled();
    expect(notices.every((notice) => notice.level === 'info')).toBe(true);
  });

  it('still tells the user when automatic fixing is switched off', async () => {
    // The old behaviour returned `skipped` and said nothing at all, which is how
    // a workspace with the toggle off would have been told a broken build worked.
    autoFixSetting.value = 'false';
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: BROKEN_FILES,
      changedPaths: Object.keys(BROKEN_FILES),
      jobId: 'job-3',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.decision).toMatchObject({ action: 'stop', reason: 'autofix-disabled' });
    expect(outcome.retry).toBeNull();
    expect(recordJobStepFailure).toHaveBeenCalledTimes(1);
    expect(notices.some((notice) => notice.message.includes('turned off'))).toBe(true);
  });

  it('refuses a second attempt at the same failure', async () => {
    const { notices, notify } = collectNotices();
    const first = checkGeneratedImports({ stack: 'NEXTJS', files: BROKEN_FILES });
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: BROKEN_FILES,
      changedPaths: Object.keys(BROKEN_FILES),
      jobId: 'job-4',
      attempt: 1,
      previousSignature: first.result.signature,
      notify,
    });

    expect(outcome.decision).toMatchObject({ action: 'stop', reason: 'no-progress' });
    expect(outcome.retry).toBeNull();
    expect(notices.some((notice) => notice.message.includes('same way'))).toBe(true);
  });

  it('reports a circular import without asking for a rewrite', async () => {
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'REACT',
      files: {
        'src/App.tsx': ["import { a } from './a';", 'export default () => <p>{a()}</p>;'].join(
          '\n',
        ),
        'src/a.ts': "import { b } from './b';\nexport const a = () => b();",
        'src/b.ts': "import { a } from './a';\nexport const b = () => a();",
      },
      changedPaths: ['src/App.tsx', 'src/a.ts', 'src/b.ts'],
      jobId: 'job-5',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.retry).toBeNull();
    expect(outcome.decision.action).toBe('none');
    expect(notices.some((notice) => notice.message.includes('circle'))).toBe(true);
  });

  it('says so when the bundler cannot run, and asks for no rewrite', async () => {
    // The trap this closes: an unavailable checker used to be indistinguishable
    // from a clean build. It must not become a code fault either — the code was
    // never examined, so there is nothing for the model to fix.
    bundleCheck.mode = 'unavailable';
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: GOOD_FILES,
      changedPaths: Object.keys(GOOD_FILES),
      jobId: 'job-6',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.result.skipReason).toBe('checker-unavailable');
    expect(outcome.retry).toBeNull();
    expect(recordJobStepFailure).toHaveBeenCalledTimes(1);
    expect(notices.some((notice) => notice.message.includes('Could not check'))).toBe(true);
  });

  it('survives a checker that throws, because the generation is already paid for', async () => {
    bundleCheck.mode = 'throws';
    const { notices, notify } = collectNotices();
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: GOOD_FILES,
      changedPaths: Object.keys(GOOD_FILES),
      jobId: 'job-7',
      attempt: 0,
      previousSignature: null,
      notify,
    });

    expect(outcome.result.status).toBe('skipped');
    expect(outcome.retry).toBeNull();
    expect(notices.some((notice) => notice.message.includes('spawn esbuild ENOENT'))).toBe(true);
  });
});
