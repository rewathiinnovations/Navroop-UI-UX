import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * This file used to hoist `PLAYWRIGHT_AUTH_JOURNEY=1` before importing
 * playwright.config.ts, because the config dropped its `setup` and
 * `authenticated` projects whenever `CI` was set — which made
 * journeys-authenticated and journeys-workflow read as orphaned under CI and
 * failed this guard for a configuration choice rather than a real hole. The
 * config declares those projects unconditionally now (they are a fatal `verify`
 * step, and CI creates the application database they need), so there is no
 * environment in which its project list is a subset any more.
 */

import vitestConfig from '../../vitest.config';
import playwrightConfig from '../../playwright.config';
import { registeredSuitePaths } from '../setup/suites';

/**
 * A test file that no runner collects is worse than no test at all: it reads as
 * coverage, counts as reassurance in review, and proves nothing. `tests/backup.test.ts`
 * sat unreferenced for months with fourteen assertions that had never executed.
 *
 * This walks the tree and fails on any test file that is not reachable from the Vitest
 * `include` globs, the suite registry in `tests/setup/suites.ts`, or a Playwright
 * project's `testMatch`.
 *
 * It walks the repository root, not just `tests/` and `e2e/`. Colocating a test beside
 * the component it covers is an ordinary thing to do, and `components/Button.test.tsx`
 * matches neither Vitest `include` glob — so before this it would have been invisible
 * to the runner *and* to this guard, which is the exact hole the guard exists to close.
 * There are no such files today; the walk is what keeps that from changing silently.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');

const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;

/**
 * Build output, dependency trees, and caches. Everything else is walked, including
 * `components/`, `hooks/`, `app/`, `lib/`, `prisma/` and `scripts/`.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'playwright-report',
  'test-results',
  'generated', // Prisma client output.
  '.data', // Runtime data directory.
  // Scratch working copies a superpowers SDD run leaves behind, one per task
  // (`.superpowers/sdd/<spec>/<task>/…`). Gitignored, so nothing there is ever
  // collected, committed or reviewed — a completed run left two copies of
  // `audit-failure-surfaces.test.ts` under it and this guard reported them as
  // orphans on every machine that still had the scratch. A real suite cannot live
  // here: the copies are of files that already exist under `tests/`.
  '.superpowers',
  '.turbo',
  '.vercel',
  'dist',
  'build',
  'out',
]);

/**
 * Walks `dir` relative to `root`. A directory containing a `.git` entry is a separate
 * checkout — a git worktree under `.claude/worktrees/`, for instance — and its files
 * belong to another branch's test run, not this one.
 */
async function walk(dir: string, root = repoRoot): Promise<string[]> {
  const entries = await readdir(resolve(root, dir), { withFileTypes: true });
  if (dir !== '.' && entries.some((entry) => entry.name === '.git')) return [];

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === '.' ? entry.name : posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(rel, root)));
      continue;
    }
    found.push(rel);
  }
  return found;
}

/**
 * Enough of glob syntax for the patterns Vitest is configured with. `**` crosses
 * directory separators, `*` does not.
 */
function globToRegExp(glob: string) {
  const pattern = glob
    .split('/')
    .map((segment) => {
      if (segment === '**') return '(?:.*)';
      return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    })
    .join('/')
    // `a/**/b` must also match `a/b`, which the segment join spells as `a//b`.
    .replace(/\/\(\?:\.\*\)\//g, '/(?:.*/)?');
  return new RegExp(`^${pattern}$`);
}

const includeGlobs = vitestConfig.test?.include ?? [];
const includeMatchers = includeGlobs.map(globToRegExp);

/** Paths in the registry are written relative to `tests/setup/`. */
const registered = new Set(
  registeredSuitePaths().map((path) => posix.normalize(posix.join('tests/setup', path))),
);

const playwrightMatchers = (playwrightConfig.projects ?? [])
  .map((project) => project.testMatch)
  .filter((match): match is RegExp => match instanceof RegExp);

function reachableBy(file: string) {
  if (includeMatchers.some((matcher) => matcher.test(file))) return 'vitest include';
  if (registered.has(file)) return 'suite registry';
  if (playwrightMatchers.some((matcher) => matcher.test(file))) return 'playwright project';
  return null;
}

const temporaryRoots: string[] = [];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'navroop-walk-'));
  temporaryRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe('every test file is reachable by a runner', () => {
  it('collects the vitest include globs', () => {
    // A typo that silently matched nothing would make this guard vacuous.
    expect(includeGlobs.length).toBeGreaterThan(0);
    expect(includeMatchers.some((matcher) => matcher.test('tests/unit/mocks.test.ts'))).toBe(true);
    expect(
      includeMatchers.some((matcher) => matcher.test('tests/integration/explain.test.ts')),
    ).toBe(true);
    expect(includeMatchers.some((matcher) => matcher.test('tests/backup.test.ts'))).toBe(false);
  });

  it('does not collect a test colocated beside its component', () => {
    // The reason the walk covers the whole repository. These are the paths a
    // developer would reach for without thinking about it, and no runner picks
    // any of them up.
    for (const file of [
      'components/ui/Button.test.tsx',
      'lib/plans/limits.test.ts',
      'app/api/health/route.test.ts',
      'hooks/useProject.test.ts',
      'scripts/backup-db.test.ts',
      'prisma/seed.test.ts',
    ]) {
      expect(reachableBy(file), file).toBeNull();
    }
  });

  it('finds a playwright project for the critical journey', () => {
    expect(playwrightMatchers.length).toBeGreaterThan(0);
    expect(reachableBy('e2e/journeys-critical.spec.ts')).toBe('playwright project');
  });

  it('walks the repository, not only tests/ and e2e/', async () => {
    const all = await walk('.');
    // The walk has to reach source directories or a colocated test would still
    // be invisible — which is the whole point of widening it.
    expect(all).toContain('package.json');
    expect(all).toContain('vitest.config.ts');
    for (const prefix of ['lib/', 'app/', 'components/', 'scripts/', 'prisma/', 'tests/', 'e2e/']) {
      expect(
        all.some((file) => file.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    // And it has to stop at build output, or this suite would read a few
    // hundred thousand files.
    for (const skipped of ['node_modules/', 'coverage/', 'generated/', '.next/']) {
      expect(
        all.some((file) => file.startsWith(skipped)),
        skipped,
      ).toBe(false);
    }
  });

  it('skips nested checkouts, build output and agent scratch', async () => {
    // Control for the three exclusion rules, on a tree this test builds, so it
    // holds on a fresh clone where no worktree and no scratch run exists.
    const root = fixtureRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'wanted.test.ts'), '');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'ignored.test.ts'), '');
    mkdirSync(join(root, 'worktree', 'tests'), { recursive: true });
    writeFileSync(join(root, 'worktree', '.git'), 'gitdir: ../../.git/worktrees/x');
    writeFileSync(join(root, 'worktree', 'tests', 'other-branch.test.ts'), '');
    // No `.git` marker of its own, so the nested-checkout rule does not cover it.
    mkdirSync(join(root, '.superpowers', 'sdd', 'base', 'task4', 'tests', 'unit'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.superpowers', 'sdd', 'base', 'task4', 'tests', 'unit', 'scratch.test.ts'),
      '',
    );

    const found = (await walk('.', root)).filter((file) => TEST_FILE.test(file));
    expect(found).toEqual(['src/wanted.test.ts']);
  });

  it('still reports a test colocated in a source directory', async () => {
    // The exclusions above must not become a way to hide a real orphan: anything
    // outside them is still walked and still classified by `reachableBy`.
    const root = fixtureRoot();
    mkdirSync(join(root, 'lib', 'plans'), { recursive: true });
    writeFileSync(join(root, 'lib', 'plans', 'limits.test.ts'), '');

    const found = (await walk('.', root)).filter((file) => TEST_FILE.test(file));
    expect(found).toEqual(['lib/plans/limits.test.ts']);
    expect(reachableBy('lib/plans/limits.test.ts')).toBeNull();
  });

  it('leaves no test file orphaned', async () => {
    const files = (await walk('.')).filter((file) => TEST_FILE.test(file));
    expect(files.length).toBeGreaterThan(30);
    // The walk must still see both trees the runners are configured for.
    expect(files.some((file) => file.startsWith('tests/unit/'))).toBe(true);
    expect(files.some((file) => file.startsWith('e2e/'))).toBe(true);

    const orphaned = files.filter((file) => reachableBy(file) === null);
    expect(
      orphaned,
      'Add the suite to tests/setup/suites.ts (PURE_SUITES or DB_SUITES), or move it under tests/unit or tests/integration. A test beside the file it covers is collected by nothing.',
    ).toEqual([]);
  });

  it('registers no suite that has been deleted', async () => {
    const onDisk = new Set(await walk('tests'));
    const missing = [...registered].filter((path) => !onDisk.has(path));
    expect(missing).toEqual([]);
  });
});
